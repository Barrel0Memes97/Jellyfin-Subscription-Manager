using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.SubscriptionManager.Models;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using MediaBrowser.Model.Users;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

/// <summary>
/// Single-writer, prepaid monthly subscriptions. Money is always stored in integer cents.
/// No collection or third-party payment processing is performed.
/// </summary>
public sealed partial class SubscriptionService
{
    private readonly IUserManager _users;
    private readonly ILogger<SubscriptionService> _logger;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly SemaphoreSlim _seerrGate = new(1, 1);
    private string _seerrStatusMessage = "Not synchronized yet";
    public string SeerrStatusMessage => _seerrStatusMessage;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;
    private readonly SubscriptionState _state;
    private readonly JsonSerializerOptions _json = new() { WriteIndented = true };

    public SubscriptionService(IApplicationPaths paths, IUserManager users, ILogger<SubscriptionService> logger, IHttpClientFactory httpClientFactory)
    {
        _users = users;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
        var dir = Path.Combine(paths.DataPath, "subscription-manager");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "subscriptions.json");
        // A corrupt file is deliberately NOT replaced with an empty ledger.
        _state = File.Exists(_path)
            ? JsonSerializer.Deserialize<SubscriptionState>(File.ReadAllText(_path), _json)
                ?? throw new InvalidDataException("Subscription database is empty or invalid")
            : new SubscriptionState();
        // Schema-compatible upgrade of 0.2.2 state: never reset plans or ledger.
        _state.Seerr ??= new SeerrSettings();
        foreach (var plan in _state.Plans)
        {
            plan.JellyfinPermissions ??= new PlanJellyfinPermissions();
            plan.SeerrRequestAccess ??= "inherit";
            plan.Description ??= string.Empty;
        }
        foreach (var member in _state.Memberships)
        {
            member.OriginalPermissions ??= new Dictionary<string, bool>();
            member.OriginalSchedules ??= new List<ScheduleSnapshot>();
            member.BillingCycle = string.IsNullOrWhiteSpace(member.BillingCycle) ? "legacy" : member.BillingCycle;
            member.BannerTitle ??= string.Empty;
            member.BannerColor ??= string.Empty;
            member.BannerMessage ??= string.Empty;
        }
    }

    private DateOnly Today()
    {
        TimeZoneInfo zone;
        try { zone = TimeZoneInfo.FindSystemTimeZoneById(_state.TimeZoneId); }
        catch (TimeZoneNotFoundException) { zone = TimeZoneInfo.Utc; }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, zone));
    }

    private void Save()
    {
        var tmp = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var payload = JsonSerializer.Serialize(_state, _json);
            File.WriteAllText(tmp, payload);
            if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS())
                File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            if (File.Exists(_path))
            {
                File.Copy(_path, _path + ".bak", true);
                if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS())
                    File.SetUnixFileMode(_path + ".bak", UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            File.Move(tmp, _path, true);
        }
        finally { if (File.Exists(tmp)) File.Delete(tmp); }
    }

    private static DateOnly NextMonth(DateOnly chargeDate, int anchor)
    {
        var next = chargeDate.AddMonths(1);
        return new DateOnly(next.Year, next.Month, Math.Min(anchor, DateTime.DaysInMonth(next.Year, next.Month)));
    }

    private Membership GetMember(Guid id) => _state.Memberships.FirstOrDefault(m => m.UserId == id)
        ?? CreateMember(id);

    private Membership CreateMember(Guid id)
    {
        var member = new Membership { UserId = id };
        _state.Memberships.Add(member);
        return member;
    }

    // Jellyfin 12.x exposes persisted user permission rows on User.Permissions.
    // HasPermission(...) is not part of the public types referenced by plugins.
    private static bool HasGrantedPermission(User user, PermissionKind kind) =>
        user.Permissions.Any(permission => permission.Kind == kind && permission.Value);

    private User RequireUser(Guid id)
    {
        var user = _users.GetUserById(id) ?? throw new ArgumentException("User does not exist in Jellyfin");
        if (HasGrantedPermission(user, PermissionKind.IsAdministrator))
            throw new ArgumentException("Administrator users cannot be enrolled");
        return user;
    }

    private static List<ScheduleSnapshot> Capture(User user) => user.AccessSchedules.Select(s => new ScheduleSnapshot
    {
        Day = s.DayOfWeek.ToString(), StartHour = s.StartHour, EndHour = s.EndHour
    }).ToList();

    private static AccessSchedule[] Restore(Membership member, Guid userId) => member.OriginalSchedules.Select(s =>
        new AccessSchedule(Enum.Parse<DynamicDayOfWeek>(s.Day), s.StartHour, s.EndHour, userId)).ToArray();

    private static AccessSchedule[] LockedSchedule(Guid userId) => new[]
    {
        DynamicDayOfWeek.Sunday, DynamicDayOfWeek.Monday, DynamicDayOfWeek.Tuesday,
        DynamicDayOfWeek.Wednesday, DynamicDayOfWeek.Thursday,
        DynamicDayOfWeek.Friday, DynamicDayOfWeek.Saturday
    }.Select(d => new AccessSchedule(d, 0, 0, userId)).ToArray();

    private static bool SchedulesMatch(IEnumerable<AccessSchedule>? oldSchedules, IEnumerable<AccessSchedule> desired)
    {
        var actual = (oldSchedules ?? Array.Empty<AccessSchedule>())
            .Select(s => (s.DayOfWeek, s.StartHour, s.EndHour)).OrderBy(x => x.DayOfWeek).ThenBy(x => x.StartHour).ToArray();
        var target = desired.Select(s => (s.DayOfWeek, s.StartHour, s.EndHour))
            .OrderBy(x => x.DayOfWeek).ThenBy(x => x.StartHour).ToArray();
        return actual.SequenceEqual(target);
    }

    private void AddLedger(Membership m, string kind, long amount, string note, Plan? plan = null,
        DateOnly? start = null, DateOnly? end = null)
    {
        m.BalanceCents = checked(m.BalanceCents + amount);
        _state.Ledger.Add(new LedgerEntry
        {
            UserId = m.UserId, Kind = kind, AmountCents = amount,
            BalanceAfterCents = m.BalanceCents, Note = note, PlanId = plan?.Id,
            CycleStart = start, CycleEnd = end
        });
    }

    private static bool IsActive(Membership m, DateOnly today) =>
        m.Included && m.PaidThrough is { } paid && paid >= today &&
        (!m.CoverageStartsOn.HasValue || m.CoverageStartsOn.Value <= today);

    private void ChargeIfDue(Membership member, DateOnly today)
    {
        if (!member.Included || IsActive(member, today)) return;
        if (member.CoverageStartsOn is { } coverage && coverage > today) return;
        var plan = _state.Plans.FirstOrDefault(p => p.Id == member.PlanId);
        if (plan is null || member.BalanceCents < plan.MonthlyCents) return;

        if (member.BillingCycle is "firstFriday" or "lastFriday")
        {
            // A missed scheduled Friday is never billed retroactively. Next attempt
            // is the next Friday of the chosen week, not an arbitrary day.
            var due = member.NextChargeOn ?? NextScheduledFriday(today, member.BillingCycle);
            if (due < today)
            {
                due = NextScheduledFriday(today, member.BillingCycle);
                member.NextChargeOn = due;
                Save();
            }
            if (due > today) return;
            var next = NextFridayInFollowingMonth(due, member.BillingCycle);
            AddLedger(member, "charge", -plan.MonthlyCents,
                $"{plan.Name}: {due:yyyy-MM-dd} to {next.AddDays(-1):yyyy-MM-dd}",
                plan, due, next.AddDays(-1));
            member.PaidThrough = next.AddDays(-1);
            member.NextChargeOn = next;
            Save();
            return;
        }

        // Preserve the pre-0.2.4 billing anchor for migrated subscriptions.
        var start = member.NextChargeOn.HasValue && member.NextChargeOn.Value >= today
            ? member.NextChargeOn.Value : today;
        var anchor = member.BillingAnchorDay is >= 1 and <= 31 ? member.BillingAnchorDay : start.Day;
        var following = NextMonth(start, anchor);
        var end = following.AddDays(-1);
        AddLedger(member, "charge", -plan.MonthlyCents,
            $"{plan.Name}: {start:yyyy-MM-dd} to {end:yyyy-MM-dd}", plan, start, end);
        member.BillingAnchorDay = anchor;
        member.PaidThrough = end;
        member.NextChargeOn = following;
        Save();
    }

    // The plugin NEVER manages administrator, disabled, library, account hiding,
    // parental, or deletion privileges through subscription plans.
    private static readonly string[] ManagedPermissionNames =
    {
        nameof(PlanJellyfinPermissions.EnableMediaPlayback),
        nameof(PlanJellyfinPermissions.EnableRemoteAccess),
        nameof(PlanJellyfinPermissions.EnableContentDownloading),
        nameof(PlanJellyfinPermissions.EnableLiveTvAccess),
        nameof(PlanJellyfinPermissions.EnableVideoPlaybackTranscoding),
        nameof(PlanJellyfinPermissions.EnableAudioPlaybackTranscoding),
        nameof(PlanJellyfinPermissions.EnablePlaybackRemuxing)
    };

    private static bool? GetPlanSetting(PlanJellyfinPermissions? settings, string name) => name switch
    {
        nameof(PlanJellyfinPermissions.EnableMediaPlayback) => settings?.EnableMediaPlayback,
        nameof(PlanJellyfinPermissions.EnableRemoteAccess) => settings?.EnableRemoteAccess,
        nameof(PlanJellyfinPermissions.EnableContentDownloading) => settings?.EnableContentDownloading,
        nameof(PlanJellyfinPermissions.EnableLiveTvAccess) => settings?.EnableLiveTvAccess,
        nameof(PlanJellyfinPermissions.EnableVideoPlaybackTranscoding) => settings?.EnableVideoPlaybackTranscoding,
        nameof(PlanJellyfinPermissions.EnableAudioPlaybackTranscoding) => settings?.EnableAudioPlaybackTranscoding,
        nameof(PlanJellyfinPermissions.EnablePlaybackRemuxing) => settings?.EnablePlaybackRemuxing,
        _ => null
    };

    private static bool ReadPolicySetting(UserPolicy policy, string name) => name switch
    {
        nameof(PlanJellyfinPermissions.EnableMediaPlayback) => policy.EnableMediaPlayback,
        nameof(PlanJellyfinPermissions.EnableRemoteAccess) => policy.EnableRemoteAccess,
        nameof(PlanJellyfinPermissions.EnableContentDownloading) => policy.EnableContentDownloading,
        nameof(PlanJellyfinPermissions.EnableLiveTvAccess) => policy.EnableLiveTvAccess,
        nameof(PlanJellyfinPermissions.EnableVideoPlaybackTranscoding) => policy.EnableVideoPlaybackTranscoding,
        nameof(PlanJellyfinPermissions.EnableAudioPlaybackTranscoding) => policy.EnableAudioPlaybackTranscoding,
        nameof(PlanJellyfinPermissions.EnablePlaybackRemuxing) => policy.EnablePlaybackRemuxing,
        _ => throw new ArgumentOutOfRangeException(nameof(name))
    };

    private static void WritePolicySetting(UserPolicy policy, string name, bool value)
    {
        switch (name)
        {
            case nameof(PlanJellyfinPermissions.EnableMediaPlayback): policy.EnableMediaPlayback = value; break;
            case nameof(PlanJellyfinPermissions.EnableRemoteAccess): policy.EnableRemoteAccess = value; break;
            case nameof(PlanJellyfinPermissions.EnableContentDownloading): policy.EnableContentDownloading = value; break;
            case nameof(PlanJellyfinPermissions.EnableLiveTvAccess): policy.EnableLiveTvAccess = value; break;
            case nameof(PlanJellyfinPermissions.EnableVideoPlaybackTranscoding): policy.EnableVideoPlaybackTranscoding = value; break;
            case nameof(PlanJellyfinPermissions.EnableAudioPlaybackTranscoding): policy.EnableAudioPlaybackTranscoding = value; break;
            case nameof(PlanJellyfinPermissions.EnablePlaybackRemuxing): policy.EnablePlaybackRemuxing = value; break;
            default: throw new ArgumentOutOfRangeException(nameof(name));
        }
    }

    private async Task ApplyAccessAsync(Membership member)
    {
        var user = _users.GetUserById(member.UserId);
        if (user is null || HasGrantedPermission(user, PermissionKind.IsAdministrator) ||
            HasGrantedPermission(user, PermissionKind.IsDisabled)) return;

        var policy = _users.GetUserDto(user).Policy
            ?? throw new InvalidOperationException("Jellyfin did not return a user policy");
        var changed = false;
        var snapshotChanged = false;
        AccessSchedule[]? desired = null;
        if (member.RestorePending && member.OriginalSchedulesCaptured)
            desired = Restore(member, user.Id);
        else if (member.Included)
            desired = IsActive(member, Today())
                ? (member.OriginalSchedulesCaptured ? Restore(member, user.Id) : Array.Empty<AccessSchedule>())
                : LockedSchedule(user.Id);

        if (desired is not null && !SchedulesMatch(user.AccessSchedules, desired))
        {
            policy.AccessSchedules = desired;
            changed = true;
        }

        var plan = member.Included ? _state.Plans.FirstOrDefault(x => x.Id == member.PlanId) : null;
        var revert = new List<string>();
        foreach (var key in ManagedPermissionNames)
        {
            bool? configured = GetPlanSetting(plan?.JellyfinPermissions, key);
            bool current = ReadPolicySetting(policy, key);
            if (configured.HasValue && member.Included)
            {
                if (!member.OriginalPermissions.ContainsKey(key))
                {
                    member.OriginalPermissions[key] = current;
                    snapshotChanged = true;
                }
                if (current != configured.Value)
                {
                    WritePolicySetting(policy, key, configured.Value);
                    changed = true;
                }
            }
            else if (member.OriginalPermissions.TryGetValue(key, out var original))
            {
                if (current != original)
                {
                    WritePolicySetting(policy, key, original);
                    changed = true;
                }
                revert.Add(key);
            }
        }
        // Capture the original values BEFORE making a remote user-policy mutation.
        if (snapshotChanged) Save();
        if (changed)
        {
            await _users.UpdatePolicyAsync(user.Id, policy).ConfigureAwait(false);
            _logger.LogInformation("Subscription permissions/access synchronized for {User}", user.Username);
        }
        foreach (var key in revert) member.OriginalPermissions.Remove(key);
        var wasRestoring = member.RestorePending;
        if (wasRestoring)
        {
            member.RestorePending = false;
            member.OriginalSchedulesCaptured = false;
            member.OriginalSchedules.Clear();
        }
        if (revert.Count > 0 || wasRestoring) Save();
    }

    private async Task ReconcileLockedAsync(CancellationToken ct)
    {
        var today = Today();
        foreach (var member in _state.Memberships)
        {
            ct.ThrowIfCancellationRequested();
            var user = _users.GetUserById(member.UserId);
            if (user is null) continue;
            if (HasGrantedPermission(user, PermissionKind.IsAdministrator)) continue;
            if (member.Included) ChargeIfDue(member, today);
            try { await ApplyAccessAsync(member).ConfigureAwait(false); }
            catch (Exception ex) { _logger.LogError(ex, "Failed to synchronize access for user {UserId}", member.UserId); }
        }
    }

    public async Task ReconcileAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { await ReconcileLockedAsync(ct).ConfigureAwait(false); }
        finally { _gate.Release(); }
        await SyncSeerrAsync(ct).ConfigureAwait(false);
    }

    public async Task<object> OverviewAsync(CancellationToken ct = default, bool recalculate = true)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (recalculate) await ReconcileLockedAsync(ct).ConfigureAwait(false);
            var today = Today();
            var users = _users.GetUsers().OrderBy(u => u.Username, StringComparer.OrdinalIgnoreCase)
                .Select(u =>
                {
                    var m = _state.Memberships.FirstOrDefault(x => x.UserId == u.Id);
                    var admin = HasGrantedPermission(u, PermissionKind.IsAdministrator);
                    var disabled = HasGrantedPermission(u, PermissionKind.IsDisabled);
                    var status = admin ? "administrator" : disabled ? "disabled" : m?.Included != true ? "not managed"
                        : m.PlanId is null ? "no plan"
                        : IsActive(m, today) ? "active" : "expired";
                    return new
                    {
                        userId = u.Id, name = u.Username, administrator = admin, disabled,
                        included = m?.Included ?? false, planId = m?.PlanId,
                        pendingPlanId = m?.PendingPlanId, pendingPlanRequestedUtc = m?.PendingPlanRequestedUtc,
                        balanceCents = m?.BalanceCents ?? 0L, paidThrough = m?.PaidThrough,
                        nextChargeOn = m?.NextChargeOn ?? (m is { BillingCycle: "firstFriday" or "lastFriday" }
                            ? (DateOnly?)NextScheduledFriday(m.PaidThrough?.AddDays(1) ?? today, m.BillingCycle) : null),
                        billingCycle = m?.BillingCycle ?? "legacy", openingRecorded = m?.OpeningRecorded ?? false,
                        coverageStartsOn = m?.CoverageStartsOn, bannerTitle = m?.BannerTitle ?? "",
                        bannerColor = m?.BannerColor ?? "", bannerMessage = m?.BannerMessage ?? "", status
                    };
                }).ToArray();
            return new
            {
                today,
                timeZoneId = _state.TimeZoneId,
                banner = _state.Banner,
                defaultPlanId = _state.DefaultPlanId,
                seerr = new { enabled = _state.Seerr.Enabled, url = _state.Seerr.Url,
                    hasApiKey = !string.IsNullOrWhiteSpace(_state.Seerr.ApiKey),
                    autoImportUsers = _state.Seerr.AutoImportUsers,
                    status = _seerrStatusMessage },
                // Explicit camelCase DTOs: Jellyfin's MVC serializer can emit PascalCase
                // for concrete C# plan objects; the admin web UI expects camelCase.
                plans = _state.Plans.OrderBy(p => p.Name).Select(p => new
                {
                    id = p.Id, name = p.Name, description = p.Description,
                    monthlyCents = p.MonthlyCents, enabled = p.Enabled,
                    seerrRequestAccess = p.SeerrRequestAccess,
                    jellyfinPermissions = new
                    {
                        enableMediaPlayback = p.JellyfinPermissions.EnableMediaPlayback,
                        enableRemoteAccess = p.JellyfinPermissions.EnableRemoteAccess,
                        enableContentDownloading = p.JellyfinPermissions.EnableContentDownloading,
                        enableLiveTvAccess = p.JellyfinPermissions.EnableLiveTvAccess,
                        enableVideoPlaybackTranscoding = p.JellyfinPermissions.EnableVideoPlaybackTranscoding,
                        enableAudioPlaybackTranscoding = p.JellyfinPermissions.EnableAudioPlaybackTranscoding,
                        enablePlaybackRemuxing = p.JellyfinPermissions.EnablePlaybackRemuxing
                    }
                }).ToArray(),
                users,
                ledger = _state.Ledger.OrderByDescending(t => t.CreatedUtc).ThenByDescending(t => t.Id)
                    .Take(1000).Select(t => new
                    {
                        id = t.Id, userId = t.UserId, createdUtc = t.CreatedUtc,
                        kind = t.Kind, amountCents = t.AmountCents,
                        cashAmountCents = t.CashAmountCents ?? (t.Kind == "deposit" ? t.AmountCents : 0),
                        balanceAfterCents = t.BalanceAfterCents, note = t.Note,
                        refundOf = t.RefundOf,
                        refunded = _state.Ledger.Any(x => x.RefundOf == t.Id),
                        refundable = (t.AmountCents != 0 || (t.CashAmountCents ?? 0) != 0)
                            && t.Kind != "refund" && t.Kind != "opening credit"
                            && t.Kind != "opening allocation"
                            && !_state.Ledger.Any(x => x.RefundOf == t.Id)
                    }).ToArray(),
                totalCollectedCents = _state.Ledger.Sum(t => t.CashAmountCents ??
                    (t.Kind == "deposit" ? t.AmountCents : 0L)),
                totalBalanceCents = _state.Memberships.Sum(m => m.BalanceCents),
                activeCount = users.Count(u => u.status == "active"),
                enrolledCount = users.Count(u => u.included),
                transactionCount = _state.Ledger.Count
            };
        }
        finally { _gate.Release(); }
    }

    public async Task UpsertPlanAsync(PlanRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Trim().Length > 80)
            throw new ArgumentException("Plan name must be 1–80 characters");
        if (req.MonthlyCents < 0 || req.MonthlyCents > 100_000_000)
            throw new ArgumentException("Monthly price must be between $0 and $1,000,000");
        if ((req.Description ?? "").Length > 500)
            throw new ArgumentException("Plan description must be 500 characters or fewer");
        if ((req.SeerrRequestAccess ?? "inherit") is not ("inherit" or "allow" or "deny"))
            throw new ArgumentException("Seerr request permission must be inherit, allow or deny");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var plan = req.Id.HasValue && req.Id != Guid.Empty
                ? _state.Plans.FirstOrDefault(p => p.Id == req.Id.Value)
                    ?? throw new ArgumentException("Plan not found")
                : new Plan();
            if (!_state.Plans.Contains(plan)) _state.Plans.Add(plan);
            if (_state.DefaultPlanId == plan.Id && !req.Enabled)
                throw new ArgumentException("Choose another default plan before hiding this one");
            plan.Name = req.Name.Trim();
            plan.MonthlyCents = req.MonthlyCents;
            plan.Description = req.Description?.Trim() ?? string.Empty;
            plan.JellyfinPermissions = req.JellyfinPermissions ?? new PlanJellyfinPermissions();
            plan.SeerrRequestAccess = req.SeerrRequestAccess ?? "inherit";
            plan.Enabled = req.Enabled; // Existing members keep their assigned plan even if hidden.
            // A single available plan is an unambiguous default for newly enrolled users.
            if (!_state.DefaultPlanId.HasValue && _state.Plans.Count(p => p.Enabled) == 1)
                _state.DefaultPlanId = _state.Plans.Single(p => p.Enabled).Id;
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task SetDefaultPlanAsync(DefaultPlanRequest req)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!req.PlanId.HasValue && _state.Plans.Any(p => p.Enabled))
                throw new ArgumentException("Choose an available plan as the default");
            if (req.PlanId.HasValue && !_state.Plans.Any(p => p.Id == req.PlanId.Value && p.Enabled))
                throw new ArgumentException("Default plan must be an available plan");
            _state.DefaultPlanId = req.PlanId;
            Save();
        }
        finally { _gate.Release(); }
    }

    public async Task SetMemberAsync(Guid userId, MemberRequest req)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var user = RequireUser(userId);
            var m = GetMember(userId);
            // A checkbox enrollment with no selected plan uses the configured default.
            // Explicit plan selection in the UI sends Included=true atomically.
            // Turning a checkbox off keeps the user's assigned plan for easy re-enrollment.
            var chosenPlanId = req.Included && !req.PlanId.HasValue
                ? _state.DefaultPlanId : req.PlanId;
            if (chosenPlanId.HasValue && !_state.Plans.Any(p => p.Id == chosenPlanId.Value))
                throw new ArgumentException("Unknown plan");
            if (req.Included && !chosenPlanId.HasValue)
                throw new ArgumentException("Set a default plan in Plans, or select a plan for this user first");
            if (req.Included)
            {
                if (!m.Included)
                {
                    // A pending restore means the original schedule is still ours to restore;
                    // do not accidentally take a snapshot of our own lockout schedule.
                    if (!m.RestorePending)
                    {
                        m.OriginalSchedules = Capture(user);
                        m.OriginalSchedulesCaptured = true;
                    }
                    m.RestorePending = false;
                }
                m.Included = true;
            }
            else if (m.Included)
            {
                m.Included = false;
                m.RestorePending = true;
            }
            // Assigning a plan must work even before a user is enrolled.
            m.PlanId = chosenPlanId;
            // An administrator choosing a plan supersedes pending self-service requests.
            m.PendingPlanId = null;
            m.PendingPlanRequestedUtc = null;
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task DepositAsync(PaymentRequest req)
    {
        if (req.AmountCents <= 0 || req.AmountCents > 100_000_000)
            throw new ArgumentException("Deposit must be between $0.01 and $1,000,000");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(req.UserId);
            var m = GetMember(req.UserId);
            AddLedger(m, "deposit", req.AmountCents, (req.Note ?? "Manual payment").Trim()[..Math.Min(250, (req.Note ?? "Manual payment").Trim().Length)]);
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task AdjustAsync(AdjustmentRequest req)
    {
        if (req.AmountCents == 0 || req.AmountCents is < -100_000_000 or > 100_000_000)
            throw new ArgumentException("Adjustment must be non-zero and within $1,000,000");
        if (string.IsNullOrWhiteSpace(req.Note)) throw new ArgumentException("An adjustment reason is required");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(req.UserId);
            var m = GetMember(req.UserId);
            if (m.BalanceCents + req.AmountCents < 0) throw new ArgumentException("Not enough balance for this adjustment");
            AddLedger(m, "adjustment", req.AmountCents, req.Note.Trim()[..Math.Min(250, req.Note.Trim().Length)]);
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task SetPaidThroughAsync(Guid userId, PaidThroughRequest req)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(userId);
            var m = GetMember(userId);
            if (!m.Included) throw new ArgumentException("Enroll this user before setting a subscription expiration");
            if (req.PaidThrough.HasValue && (req.PaidThrough.Value < new DateOnly(2000, 1, 1) ||
                req.PaidThrough.Value > Today().AddYears(10)))
                throw new ArgumentException("Expiration must be within the supported date range");
            m.PaidThrough = req.PaidThrough;
            m.NextChargeOn = req.PaidThrough.HasValue
                ? NextDueAfter(req.PaidThrough.Value, m.BillingCycle)
                : (m.BillingCycle is "firstFriday" or "lastFriday"
                    ? NextScheduledFriday(Today(), m.BillingCycle) : null);
            m.CoverageStartsOn = null;
            m.BillingAnchorDay = m.BillingCycle == "legacy" ? m.NextChargeOn?.Day ?? 0 : 0;
            AddLedger(m, "expiration override", 0, (req.Note ?? "Manual expiration change").Trim());
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task SetSettingsAsync(SettingsRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.TimeZoneId)) throw new ArgumentException("Time zone is required");
        try { _ = TimeZoneInfo.FindSystemTimeZoneById(req.TimeZoneId); }
        catch (TimeZoneNotFoundException) { throw new ArgumentException("Invalid time zone ID"); }
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            _state.TimeZoneId = req.TimeZoneId;
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    /// <summary>Returns only the currently authenticated user's banner data.</summary>
    public async Task<object> GetBannerForUserAsync(Guid userId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var user = _users.GetUserById(userId);
            if (user is null) throw new ArgumentException("User does not exist");
            var b = _state.Banner ?? new BannerSettings();
            var today = Today();
            var admin = HasGrantedPermission(user, PermissionKind.IsAdministrator);
            var m = _state.Memberships.FirstOrDefault(x => x.UserId == userId);
            var plan = _state.Plans.FirstOrDefault(p => p.Id == m?.PlanId);
            var enrolled = m?.Included == true;
            // The active check implies paid-through coverage, but the compiler cannot
            // infer that invariant through IsActive. Pattern-match the date explicitly.
            var status = !enrolled || admin ? "unmanaged" :
                m is not null && IsActive(m, today) && m.PaidThrough is { } paidThrough
                    ? (paidThrough.DayNumber - today.DayNumber <= b.WarningDays ? "expiring" : "active")
                    : "expired";
            var show = b.Enabled && !HasGrantedPermission(user, PermissionKind.IsDisabled) &&
                (admin ? b.ShowAdmins : status switch
                {
                    "active" => b.ShowActive,
                    "expiring" => b.ShowExpiring,
                    "expired" => b.ShowExpired,
                    _ => b.ShowUnmanaged
                });
            return new
            {
                show, status,
                userName = b.ShowUserName ? user.Username : null,
                // No admin data, other-user balances, or transaction records are exposed.
                plan = b.ShowPlan && enrolled ? plan?.Name : null,
                paidThrough = b.ShowPaidThrough && enrolled ? m?.PaidThrough : null,
                balanceCents = b.ShowBalance && enrolled ? m?.BalanceCents : null,
                renewalOn = b.ShowRenewal && enrolled ? m?.NextChargeOn : null,
                customTitle = m?.BannerTitle,
                customColor = status == "active" ? m?.BannerColor : null,
                customMessage = status == "active" ? m?.BannerMessage : null,
                daysRemaining = b.ShowDaysRemaining && enrolled && m?.PaidThrough is { } through
                    ? Math.Max(0, through.DayNumber - today.DayNumber) : (int?)null,
                appearance = new
                {
                    position = b.Position, layout = b.Layout, gradient = b.Gradient,
                    icon = b.Icon, titleTemplate = b.TitleTemplate,
                    dismissible = b.Dismissible, refreshMinutes = b.RefreshMinutes,
                    activeText = b.ActiveText, expiringText = b.ExpiringText,
                    expiredText = b.ExpiredText, unmanagedText = b.UnmanagedText,
                    activeColor = b.ActiveColor, expiringColor = b.ExpiringColor,
                    expiredColor = b.ExpiredColor, unmanagedColor = b.UnmanagedColor
                }
            };
        }
        finally { _gate.Release(); }
    }

    public async Task SetBannerAsync(BannerSettings? requested)
    {
        if (requested is null) throw new ArgumentException("Banner settings are required");
        if (requested.WarningDays is < 0 or > 365) throw new ArgumentException("Warning days must be 0–365");
        if (requested.RefreshMinutes is < 1 or > 120) throw new ArgumentException("Refresh interval must be 1–120 minutes");
        if (requested.Position is not ("top" or "bottom")) throw new ArgumentException("Position must be top or bottom");
        if (requested.Layout is not ("home" or "floating")) throw new ArgumentException("Banner layout must be home or floating");
        if (requested.Icon is null || requested.Icon.Length > 12 ||
            requested.TitleTemplate is null || requested.TitleTemplate.Length > 120)
            throw new ArgumentException("Banner icon or title is too long");
        static bool ColorOk(string? color) => color is not null && Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$");
        if (!ColorOk(requested.ActiveColor) || !ColorOk(requested.ExpiringColor) ||
            !ColorOk(requested.ExpiredColor) || !ColorOk(requested.UnmanagedColor))
            throw new ArgumentException("Colors must use six-digit hexadecimal values, e.g. #166534");
        if (new[] { requested.ActiveText, requested.ExpiringText, requested.ExpiredText, requested.UnmanagedText }
            .Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 120))
            throw new ArgumentException("Banner messages must contain 1–120 characters");
        await _gate.WaitAsync().ConfigureAwait(false);
        try { _state.Banner = requested; Save(); }
        finally { _gate.Release(); }
    }
}

