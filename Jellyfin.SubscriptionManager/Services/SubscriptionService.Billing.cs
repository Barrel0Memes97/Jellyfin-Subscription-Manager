using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.SubscriptionManager.Models;
using Jellyfin.Database.Implementations.Enums;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

public sealed partial class SubscriptionService
{
    public string LastManualSyncMessage { get; private set; } = "Not run yet";

    internal static DateOnly FridayForMonth(int year, int month, string cycle)
    {
        if (cycle == "firstFriday")
        {
            var first = new DateOnly(year, month, 1);
            var offset = ((int)DayOfWeek.Friday - (int)first.DayOfWeek + 7) % 7;
            return first.AddDays(offset);
        }
        if (cycle == "lastFriday")
        {
            var last = new DateOnly(year, month, DateTime.DaysInMonth(year, month));
            var offset = ((int)last.DayOfWeek - (int)DayOfWeek.Friday + 7) % 7;
            return last.AddDays(-offset);
        }
        throw new ArgumentException("Choose first Friday or last Friday");
    }

    internal static DateOnly NextScheduledFriday(DateOnly from, string cycle)
    {
        var candidate = FridayForMonth(from.Year, from.Month, cycle);
        if (candidate >= from) return candidate;
        var month = new DateOnly(from.Year, from.Month, 1).AddMonths(1);
        return FridayForMonth(month.Year, month.Month, cycle);
    }

    internal static DateOnly NextFridayInFollowingMonth(DateOnly from, string cycle)
    {
        var month = new DateOnly(from.Year, from.Month, 1).AddMonths(1);
        return FridayForMonth(month.Year, month.Month, cycle);
    }

    internal static DateOnly NextDueAfter(DateOnly paidThrough, string cycle) =>
        cycle is "firstFriday" or "lastFriday"
            ? NextScheduledFriday(paidThrough.AddDays(1), cycle)
            : paidThrough.AddDays(1);

    public async Task SetBillingCycleAsync(Guid userId, BillingCycleRequest request)
    {
        if (request.Cycle is not ("legacy" or "firstFriday" or "lastFriday"))
            throw new ArgumentException("Choose Original, first Friday, or last Friday");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(userId);
            var member = GetMember(userId);
            member.BillingCycle = request.Cycle;
            member.NextChargeOn = member.PaidThrough is { } paid
                ? NextDueAfter(paid, request.Cycle)
                : request.Cycle is "firstFriday" or "lastFriday"
                    ? NextScheduledFriday(Today(), request.Cycle) : Today();
            member.BillingAnchorDay = request.Cycle == "legacy" ? member.NextChargeOn?.Day ?? 0 : 0;
            Save();
            // Updating a cycle does not silently charge an account or shorten coverage.
            await ApplyAccessAsync(member).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task SetUserBannerAsync(Guid userId, UserBannerRequest request)
    {
        var title = (request.Title ?? string.Empty).Trim();
        var color = (request.Color ?? string.Empty).Trim();
        var message = (request.Message ?? string.Empty).Trim();
        if (title.Length > 120 || message.Length > 250 ||
            (color.Length > 0 && !Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$")))
            throw new ArgumentException("Custom title must be 120 characters or fewer, active message 250 or fewer, and color #RRGGBB");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(userId);
            var member = GetMember(userId);
            member.BannerTitle = title;
            member.BannerColor = color;
            member.BannerMessage = message;
            Save();
        }
        finally { _gate.Release(); }
    }

    public async Task RecordOpeningAsync(Guid userId, OpeningRequest request)
    {
        if (request.Mode is not ("paidThrough" or "credit"))
            throw new ArgumentException("Choose paid-through date or starting credit");
        if (request.StartDate < new DateOnly(2000, 1, 1) || request.StartDate > Today().AddYears(10))
            throw new ArgumentException("Enter a valid subscription start date");
        if (request.FirstPaymentCents is < 0 or > 100_000_000 ||
            request.StartingCreditCents is < 0 or > 100_000_000)
            throw new ArgumentException("Payment and credit must be between $0 and $1,000,000");
        if (request.Mode == "paidThrough" &&
            (!request.PaidThrough.HasValue || request.PaidThrough.Value < request.StartDate ||
             request.PaidThrough.Value > Today().AddYears(10)))
            throw new ArgumentException("Paid-through date must be on/after the starting date");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(userId);
            var member = GetMember(userId);
            if (!member.Included) throw new ArgumentException("Enroll the user before recording opening coverage");
            if (member.OpeningRecorded) throw new ArgumentException("Opening settings are already recorded. Use Add funds or manual expiration changes for later updates.");
            var plan = _state.Plans.FirstOrDefault(p => p.Id == member.PlanId)
                ?? throw new ArgumentException("Assign a valid plan first");
            if (request.Mode == "credit" && plan.MonthlyCents <= 0)
                throw new ArgumentException("Credit-based month calculation needs a plan with a price greater than $0");
            if (request.Mode == "credit" && request.StartingCreditCents / plan.MonthlyCents > 120)
                throw new ArgumentException("At most 120 prepaid months can be allocated at once");
            if (request.StartingCreditCents > 0 && member.BalanceCents > long.MaxValue - request.StartingCreditCents)
                throw new ArgumentException("Starting credit would overflow the account balance");

            member.CoverageStartsOn = request.StartDate;
            if (request.FirstPaymentCents > 0)
            {
                // Historical receipt, NOT another balance deposit. The opening credit
                // below is the only balance amount. Never count the payment twice.
                _state.Ledger.Add(new LedgerEntry
                {
                    UserId = userId, Kind = "first payment", AmountCents = 0,
                    CashAmountCents = request.FirstPaymentCents,
                    BalanceAfterCents = member.BalanceCents,
                    CycleStart = request.StartDate,
                    Note = (request.Note ?? "Historical first payment (not double-credited)").Trim()[..Math.Min(250, (request.Note ?? "Historical first payment (not double-credited)").Trim().Length)]
                });
            }
            if (request.Mode == "paidThrough")
            {
                member.PaidThrough = request.PaidThrough;
                member.NextChargeOn = NextDueAfter(request.PaidThrough!.Value, member.BillingCycle);
                AddLedger(member, "opening coverage", 0,
                    $"Historical coverage from {request.StartDate:yyyy-MM-dd} to {request.PaidThrough:yyyy-MM-dd}",
                    plan, request.StartDate, request.PaidThrough);
            }
            else
            {
                // Allocate complete months; the remainder is retained as spendable balance.
                // Starting credit is not assumed to equal the historical first payment.
                if (request.StartingCreditCents > 0)
                    AddLedger(member, "opening credit", request.StartingCreditCents,
                        "Initial credit imported; historical payment separately recorded");
                var wholeMonths = request.StartingCreditCents / plan.MonthlyCents;
                var boundary = request.StartDate;
                for (var i = 0; i < wholeMonths; i++)
                {
                    var next = member.BillingCycle is "firstFriday" or "lastFriday"
                        ? NextFridayInFollowingMonth(boundary, member.BillingCycle)
                        : NextMonth(boundary, request.StartDate.Day);
                    AddLedger(member, "opening allocation", -plan.MonthlyCents,
                        $"Opening prepaid month {i + 1}/{wholeMonths}: {boundary:yyyy-MM-dd} to {next.AddDays(-1):yyyy-MM-dd}",
                        plan, boundary, next.AddDays(-1));
                    boundary = next;
                }
                member.PaidThrough = wholeMonths > 0 ? boundary.AddDays(-1) : null;
                member.NextChargeOn = wholeMonths > 0 ? boundary :
                    member.BillingCycle is "firstFriday" or "lastFriday"
                        ? NextScheduledFriday(request.StartDate, member.BillingCycle) : request.StartDate;
            }
            member.BillingAnchorDay = member.BillingCycle == "legacy" ? request.StartDate.Day : 0;
            member.OpeningRecorded = true;
            Save();
            await ApplyAccessAsync(member).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    public async Task RefundAsync(Guid transactionId, RefundRequest request)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var original = _state.Ledger.FirstOrDefault(x => x.Id == transactionId)
                ?? throw new ArgumentException("Transaction was not found");
            if (original.Kind is "refund" or "opening credit" or "opening allocation" ||
                (original.AmountCents == 0 && original.CashAmountCents.GetValueOrDefault() == 0))
                throw new ArgumentException("This transaction cannot be refunded");
            if (_state.Ledger.Any(x => x.RefundOf == transactionId))
                throw new ArgumentException("This transaction has already been refunded");
            RequireUser(original.UserId);
            var member = GetMember(original.UserId);
            // A full reversal is audit-safe: preserve original record. Negative credit
            // is allowed after previously purchased months were consumed. Never extend
            // or revoke existing paid-through coverage implicitly.
            AddLedger(member, "refund", checked(-original.AmountCents),
                ("Refund/reversal of " + original.Kind + ": " + (request.Note ?? "Admin refund").Trim())[..Math.Min(250, ("Refund/reversal of " + original.Kind + ": " + (request.Note ?? "Admin refund").Trim()).Length)]);
            var reversal = _state.Ledger[^1];
            reversal.RefundOf = original.Id;
            reversal.CashAmountCents = original.CashAmountCents.HasValue ? -original.CashAmountCents.Value :
                original.Kind == "deposit" ? -original.AmountCents : 0;
            Save();
            await ApplyAccessAsync(member).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    /// <summary>Reapply policies and Seerr bits without making recurring charges.</summary>
    public async Task SyncStatusesAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        var updated = 0;
        var failed = 0;
        try
        {
            foreach (var member in _state.Memberships)
            {
                ct.ThrowIfCancellationRequested();
                var user = _users.GetUserById(member.UserId);
                if (user is null || HasGrantedPermission(user, PermissionKind.IsAdministrator)) continue;
                try { await ApplyAccessAsync(member).ConfigureAwait(false); updated++; }
                catch (Exception ex)
                {
                    failed++;
                    _logger.LogWarning(ex, "Manual permission sync failed for {UserId}", member.UserId);
                }
            }
        }
        finally { _gate.Release(); }
        await SyncSeerrAsync(ct).ConfigureAwait(false);
        LastManualSyncMessage = $"Jellyfin: {updated} checked, {failed} errors. " + SeerrStatusMessage;
    }
}
