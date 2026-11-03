using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.SubscriptionManager.Models;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

/// <summary>
/// Single-writer, prepaid monthly subscriptions. Money is always stored in integer cents.
/// No collection or third-party payment processing is performed.
/// </summary>
public sealed class SubscriptionService
{
    private readonly IUserManager _users;
    private readonly ILogger<SubscriptionService> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;
    private readonly SubscriptionState _state;
    private readonly JsonSerializerOptions _json = new() { WriteIndented = true };

    public SubscriptionService(IApplicationPaths paths, IUserManager users, ILogger<SubscriptionService> logger)
    {
        _users = users;
        _logger = logger;
        var dir = Path.Combine(paths.DataPath, "subscription-manager");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "subscriptions.json");
        // A corrupt file is deliberately NOT replaced with an empty ledger.
        _state = File.Exists(_path)
            ? JsonSerializer.Deserialize<SubscriptionState>(File.ReadAllText(_path), _json)
                ?? throw new InvalidDataException("Subscription database is empty or invalid")
            : new SubscriptionState();
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
            if (File.Exists(_path)) File.Copy(_path, _path + ".bak", true);
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

    private void ChargeIfDue(Membership member, DateOnly today)
    {
        if (!member.Included || (member.PaidThrough.HasValue && member.PaidThrough.Value >= today)) return;
        var plan = _state.Plans.FirstOrDefault(p => p.Id == member.PlanId);
        if (plan is null || member.BalanceCents < plan.MonthlyCents) return;

        // If funds ran out, do not back-bill months during which access was expired.
        var start = member.NextChargeOn.HasValue && member.NextChargeOn.Value >= today
            ? member.NextChargeOn.Value : today;
        var anchor = member.BillingAnchorDay is >= 1 and <= 31 ? member.BillingAnchorDay : start.Day;
        var next = NextMonth(start, anchor);
        var end = next.AddDays(-1);
        AddLedger(member, "charge", -plan.MonthlyCents, $"{plan.Name}: {start:yyyy-MM-dd} to {end:yyyy-MM-dd}",
            plan, start, end);
        member.BillingAnchorDay = anchor;
        member.PaidThrough = end;
        member.NextChargeOn = next;
        Save(); // Persist the charge before changing Jellyfin access.
    }

    private async Task ApplyAccessAsync(Membership member)
    {
        var user = _users.GetUserById(member.UserId);
        if (user is null) return;
        if (HasGrantedPermission(user, PermissionKind.IsAdministrator)) return;
        if (HasGrantedPermission(user, PermissionKind.IsDisabled)) return; // Respect manual account disable.
        AccessSchedule[] desired;
        if (member.RestorePending)
        {
            if (!member.OriginalSchedulesCaptured) { member.RestorePending = false; Save(); return; }
            desired = Restore(member, user.Id);
        }
        else if (member.Included)
        {
            desired = member.PaidThrough.HasValue && member.PaidThrough.Value >= Today()
                ? (member.OriginalSchedulesCaptured ? Restore(member, user.Id) : Array.Empty<AccessSchedule>())
                : LockedSchedule(user.Id);
        }
        else return;

        if (!SchedulesMatch(user.AccessSchedules, desired))
        {
            // Get a complete fresh policy and change ONLY schedules. Every other
            // Jellyfin permission/setting stays in the policy that was read.
            var policy = _users.GetUserDto(user).Policy
                ?? throw new InvalidOperationException("Jellyfin did not return a user policy");
            policy.AccessSchedules = desired;
            await _users.UpdatePolicyAsync(user.Id, policy).ConfigureAwait(false);
            _logger.LogInformation("Subscription access synchronized for {User}", user.Username);
        }
        if (member.RestorePending)
        {
            member.RestorePending = false;
            member.OriginalSchedulesCaptured = false;
            member.OriginalSchedules.Clear();
            Save();
        }
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
    }

    public async Task<object> OverviewAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await ReconcileLockedAsync(ct).ConfigureAwait(false);
            var today = Today();
            var users = _users.GetUsers().OrderBy(u => u.Username, StringComparer.OrdinalIgnoreCase)
                .Select(u =>
                {
                    var m = _state.Memberships.FirstOrDefault(x => x.UserId == u.Id);
                    var admin = HasGrantedPermission(u, PermissionKind.IsAdministrator);
                    var disabled = HasGrantedPermission(u, PermissionKind.IsDisabled);
                    var status = admin ? "administrator" : disabled ? "disabled" : m?.Included != true ? "not managed"
                        : m.PlanId is null ? "no plan"
                        : m.PaidThrough.HasValue && m.PaidThrough.Value >= today ? "active" : "expired";
                    return new
                    {
                        userId = u.Id, name = u.Username, administrator = admin, disabled,
                        included = m?.Included ?? false, planId = m?.PlanId,
                        balanceCents = m?.BalanceCents ?? 0L, paidThrough = m?.PaidThrough,
                        nextChargeOn = m?.NextChargeOn, status
                    };
                }).ToArray();
            return new
            {
                today,
                timeZoneId = _state.TimeZoneId,
                banner = _state.Banner,
                plans = _state.Plans.OrderBy(p => p.Name).ToArray(),
                users,
                ledger = _state.Ledger.OrderByDescending(t => t.CreatedUtc).ThenByDescending(t => t.Id).Take(1000).ToArray(),
                totalCollectedCents = _state.Ledger.Where(t => t.Kind == "deposit").Sum(t => t.AmountCents),
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
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var plan = req.Id.HasValue && req.Id != Guid.Empty
                ? _state.Plans.FirstOrDefault(p => p.Id == req.Id.Value)
                    ?? throw new ArgumentException("Plan not found")
                : new Plan();
            if (!_state.Plans.Contains(plan)) _state.Plans.Add(plan);
            plan.Name = req.Name.Trim();
            plan.MonthlyCents = req.MonthlyCents;
            plan.Enabled = req.Enabled; // Existing members keep their assigned plan even if hidden.
            Save();
            await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
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
            if (req.PlanId.HasValue && !_state.Plans.Any(p => p.Id == req.PlanId.Value))
                throw new ArgumentException("Unknown plan");
            if (req.Included && !req.PlanId.HasValue)
                throw new ArgumentException("Choose an existing plan first");
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
            m.PlanId = req.PlanId;
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
            m.NextChargeOn = req.PaidThrough?.AddDays(1);
            m.BillingAnchorDay = m.NextChargeOn?.Day ?? 0;
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
            var status = !enrolled || admin ? "unmanaged" :
                m!.PaidThrough.HasValue && m.PaidThrough.Value >= today
                    ? (m.PaidThrough.Value.DayNumber - today.DayNumber <= b.WarningDays ? "expiring" : "active")
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
                daysRemaining = b.ShowDaysRemaining && enrolled && m?.PaidThrough is { } through
                    ? Math.Max(0, through.DayNumber - today.DayNumber) : (int?)null,
                appearance = new
                {
                    b.Position, b.Dismissible, b.RefreshMinutes,
                    b.ActiveText, b.ExpiringText, b.ExpiredText, b.UnmanagedText,
                    b.ActiveColor, b.ExpiringColor, b.ExpiredColor, b.UnmanagedColor
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

