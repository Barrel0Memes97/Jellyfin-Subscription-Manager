namespace Jellyfin.Plugin.SubscriptionManager.Models;

public sealed class SubscriptionState
{
    public string TimeZoneId { get; set; } = "UTC";
    public BannerSettings Banner { get; set; } = new();
    public List<Plan> Plans { get; set; } = new();
    public List<Membership> Memberships { get; set; } = new();
    public List<LedgerEntry> Ledger { get; set; } = new();
}

public sealed class Plan
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "Standard";
    public long MonthlyCents { get; set; }
    public bool Enabled { get; set; } = true;
}

public sealed class Membership
{
    public Guid UserId { get; set; }
    public bool Included { get; set; }
    public Guid? PlanId { get; set; }
    public long BalanceCents { get; set; }
    public DateOnly? PaidThrough { get; set; }
    public DateOnly? NextChargeOn { get; set; }
    public int BillingAnchorDay { get; set; }
    public List<ScheduleSnapshot> OriginalSchedules { get; set; } = new();
    public bool OriginalSchedulesCaptured { get; set; }
    public bool RestorePending { get; set; }
}

public sealed class ScheduleSnapshot
{
    public string Day { get; set; } = "Sunday";
    public double StartHour { get; set; }
    public double EndHour { get; set; }
}

public sealed class LedgerEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public string Kind { get; set; } = "deposit";
    public long AmountCents { get; set; }
    public long BalanceAfterCents { get; set; }
    public string Note { get; set; } = string.Empty;
    public Guid? PlanId { get; set; }
    public DateOnly? CycleStart { get; set; }
    public DateOnly? CycleEnd { get; set; }
}

public sealed record PlanRequest(Guid? Id, string Name, long MonthlyCents, bool Enabled);
public sealed record MemberRequest(bool Included, Guid? PlanId);
public sealed record PaymentRequest(Guid UserId, long AmountCents, string? Note);
public sealed record AdjustmentRequest(Guid UserId, long AmountCents, string? Note);
public sealed record PaidThroughRequest(DateOnly? PaidThrough, string? Note);
public sealed record SettingsRequest(string TimeZoneId);

/// <summary>Appearance and visibility for the Jellyfin Web user banner.</summary>
public sealed class BannerSettings
{
    public bool Enabled { get; set; } = true;
    public bool ShowActive { get; set; } = true;
    public bool ShowExpiring { get; set; } = true;
    public bool ShowExpired { get; set; } = true;
    public bool ShowUnmanaged { get; set; }
    public bool ShowAdmins { get; set; }
    public bool ShowUserName { get; set; } = true;
    public bool ShowDaysRemaining { get; set; } = true;
    public bool ShowPlan { get; set; } = true;
    public bool ShowPaidThrough { get; set; } = true;
    public bool ShowBalance { get; set; }
    public bool Dismissible { get; set; } = true;
    public int WarningDays { get; set; } = 7;
    public int RefreshMinutes { get; set; } = 5;
    public string Position { get; set; } = "top";
    public string ActiveText { get; set; } = "Subscription active";
    public string ExpiringText { get; set; } = "Subscription expires soon";
    public string ExpiredText { get; set; } = "Subscription expired";
    public string UnmanagedText { get; set; } = "Subscription not configured";
    public string ActiveColor { get; set; } = "#166534";
    public string ExpiringColor { get; set; } = "#92400e";
    public string ExpiredColor { get; set; } = "#991b1b";
    public string UnmanagedColor { get; set; } = "#374151";
}

public sealed record BannerRequest(BannerSettings Banner);
