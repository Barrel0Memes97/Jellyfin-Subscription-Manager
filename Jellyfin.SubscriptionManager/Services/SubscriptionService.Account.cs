using Jellyfin.Plugin.SubscriptionManager.Models;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

/// <summary>
/// Subscriber self-service: every operation is scoped to the authenticated
/// Jellyfin user ID supplied by the controller, never an ID from the client.
/// Plan requests are approvals, not changes to privileges or account credit.
/// </summary>
public sealed partial class SubscriptionService
{
    public async Task<object> GetAccountAsync(Guid userId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var user = _users.GetUserById(userId)
                ?? throw new ArgumentException("Jellyfin account was not found");
            var member = _state.Memberships.FirstOrDefault(m => m.UserId == userId);
            var plan = _state.Plans.FirstOrDefault(p => p.Id == member?.PlanId);
            var pending = _state.Plans.FirstOrDefault(p => p.Id == member?.PendingPlanId);
            var today = Today();
            var status = member?.Included != true ? "not managed"
                : member.PlanId is null ? "no plan"
                : IsActive(member, today) ? "active" : "expired";
            var nextCharge = member?.NextChargeOn ?? (member is { BillingCycle: "firstFriday" or "lastFriday" }
                ? (DateOnly?)NextScheduledFriday(member.PaidThrough?.AddDays(1) ?? today, member.BillingCycle)
                : null);
            return new
            {
                name = user.Username,
                status,
                managed = member?.Included == true,
                today,
                timeZoneId = _state.TimeZoneId,
                plan = plan is null ? null : new { id = plan.Id, name = plan.Name, description = plan.Description,
                    monthlyCents = plan.MonthlyCents },
                balanceCents = member?.BalanceCents ?? 0L,
                paidThrough = member?.PaidThrough,
                coverageStartsOn = member?.CoverageStartsOn,
                renewalOn = nextCharge,
                billingCycle = member?.BillingCycle ?? "legacy",
                // Only enabled alternatives may be requested; the current plan
                // remains visible even if hidden by the administrator.
                availablePlans = _state.Plans.Where(p => p.Enabled || p.Id == member?.PlanId)
                    .OrderBy(p => p.MonthlyCents).ThenBy(p => p.Name)
                    .Select(p => new { id = p.Id, name = p.Name, description = p.Description,
                        monthlyCents = p.MonthlyCents, selectable = p.Enabled }).ToArray(),
                pendingPlan = pending is null ? null : new { id = pending.Id, name = pending.Name,
                    monthlyCents = pending.MonthlyCents },
                pendingSinceUtc = member?.PendingPlanRequestedUtc,
                banner = new { title = member?.BannerTitle ?? "", color = member?.BannerColor ?? "",
                    message = member?.BannerMessage ?? "" },
                // This endpoint never exposes other subscribers, Seerr secrets,
                // administrator-only adjustment notes, or the full transaction ledger.
                transactions = _state.Ledger.Where(t => t.UserId == userId)
                    .OrderByDescending(t => t.CreatedUtc).ThenByDescending(t => t.Id).Take(100)
                    .Select(t => new { id = t.Id, createdUtc = t.CreatedUtc, kind = t.Kind,
                        amountCents = t.AmountCents, balanceAfterCents = t.BalanceAfterCents,
                        note = t.Kind is "deposit" or "charge" or "first payment" ? t.Note : "",
                        cycleStart = t.CycleStart, cycleEnd = t.CycleEnd }).ToArray()
            };
        }
        finally { _gate.Release(); }
    }

    public async Task RequestPlanChangeAsync(Guid userId, AccountPlanRequest request)
    {
        if (request.PlanId == Guid.Empty) throw new ArgumentException("Choose a plan");
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(userId);
            // Do not create memberships or silently enroll users through a
            // subscriber-facing request. Enrollment remains administrator-only.
            var member = _state.Memberships.FirstOrDefault(m => m.UserId == userId);
            if (member?.Included != true) throw new ArgumentException("Ask the administrator to enroll your account first");
            var plan = _state.Plans.FirstOrDefault(p => p.Id == request.PlanId && p.Enabled);
            if (plan is null) throw new ArgumentException("The selected plan is not available");
            if (member.PlanId == request.PlanId) throw new ArgumentException("You are already on that plan");
            if (member.PendingPlanId.HasValue) throw new ArgumentException("A plan change request is already awaiting review");
            member.PendingPlanId = plan.Id;
            member.PendingPlanRequestedUtc = DateTime.UtcNow;
            Save();
        }
        finally { _gate.Release(); }
    }

    public async Task ReviewPlanChangeAsync(Guid userId, AccountPlanReviewRequest request)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            RequireUser(userId);
            var member = _state.Memberships.FirstOrDefault(m => m.UserId == userId);
            if (member?.PendingPlanId is not Guid requestedId)
                throw new ArgumentException("No pending plan request was found");
            if (!member.Included) throw new ArgumentException("This user is no longer enrolled");
            if (request.Approve)
            {
                var plan = _state.Plans.FirstOrDefault(p => p.Id == requestedId && p.Enabled)
                    ?? throw new ArgumentException("The requested plan is no longer available");
                member.PlanId = plan.Id;
            }
            member.PendingPlanId = null;
            member.PendingPlanRequestedUtc = null;
            Save();
            if (request.Approve)
                await ReconcileLockedAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
        if (request.Approve) await SyncSeerrAsync().ConfigureAwait(false);
    }
}
