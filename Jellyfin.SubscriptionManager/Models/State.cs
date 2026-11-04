using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.SubscriptionManager.Models;

public sealed class SubscriptionState
{
    public string TimeZoneId { get; set; } = "UTC";
    public BannerSettings Banner { get; set; } = new();
    public SeerrSettings Seerr { get; set; } = new();
    // The plan used when an administrator enrolls a user without first choosing one.
    public Guid? DefaultPlanId { get; set; }
    public List<Plan> Plans { get; set; } = new();
    public List<Membership> Memberships { get; set; } = new();
    public List<LedgerEntry> Ledger { get; set; } = new();
}

public sealed class Plan
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "Standard";
    public string Description { get; set; } = string.Empty;
    public long MonthlyCents { get; set; }
    public bool Enabled { get; set; } = true;
    // Null = do not manage this Jellyfin permission; true/false = enforce on enrolled users.
    public PlanJellyfinPermissions JellyfinPermissions { get; set; } = new();
    // inherit, allow, deny. Existing plans default to inherit so upgrades don't change Seerr.
    public string SeerrRequestAccess { get; set; } = "inherit";
}

public sealed class PlanJellyfinPermissions
{
    [JsonPropertyName("enableMediaPlayback")]
    public bool? EnableMediaPlayback { get; set; }
    [JsonPropertyName("enableRemoteAccess")]
    public bool? EnableRemoteAccess { get; set; }
    [JsonPropertyName("enableContentDownloading")]
    public bool? EnableContentDownloading { get; set; }
    [JsonPropertyName("enableLiveTvAccess")]
    public bool? EnableLiveTvAccess { get; set; }
    [JsonPropertyName("enableVideoPlaybackTranscoding")]
    public bool? EnableVideoPlaybackTranscoding { get; set; }
    [JsonPropertyName("enableAudioPlaybackTranscoding")]
    public bool? EnableAudioPlaybackTranscoding { get; set; }
    [JsonPropertyName("enablePlaybackRemuxing")]
    public bool? EnablePlaybackRemuxing { get; set; }
}

public sealed class SeerrSettings
{
    public bool Enabled { get; set; }
    public string Url { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public bool AutoImportUsers { get; set; }
}

public sealed class Membership
{
    public Guid UserId { get; set; }
    public bool Included { get; set; }
    public Guid? PlanId { get; set; }
    // A subscriber may request a different plan, but only an administrator may approve it.
    public Guid? PendingPlanId { get; set; }
    public DateTime? PendingPlanRequestedUtc { get; set; }
    public long BalanceCents { get; set; }
    public DateOnly? PaidThrough { get; set; }
    public DateOnly? NextChargeOn { get; set; }
    public int BillingAnchorDay { get; set; }
    // "legacy" keeps pre-0.2.4 monthly anchors; new users may choose a Friday.
    public string BillingCycle { get; set; } = "legacy";
    public DateOnly? CoverageStartsOn { get; set; }
    public bool OpeningRecorded { get; set; }
    public string BannerTitle { get; set; } = string.Empty;
    // Optional active-only appearance overrides. Expiry warnings keep their global text/color.
    public string BannerColor { get; set; } = string.Empty;
    public string BannerMessage { get; set; } = string.Empty;
    public List<ScheduleSnapshot> OriginalSchedules { get; set; } = new();
    public bool OriginalSchedulesCaptured { get; set; }
    public bool RestorePending { get; set; }
    // Original values of ONLY the per-plan permissions modified by this plugin.
    public Dictionary<string, bool> OriginalPermissions { get; set; } = new();
    // Original Seerr request-related bits only; never store or modify the other permission bits.
    public int? SeerrOriginalRequestBits { get; set; }
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
    // Cash actually received/refunded, distinct from the account-credit delta.
    // For older deposits the cash amount is inferred from AmountCents.
    public long? CashAmountCents { get; set; }
    public Guid? RefundOf { get; set; }
}

public sealed record PlanRequest(
    [property: JsonPropertyName("id")] Guid? Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("monthlyCents")] long MonthlyCents,
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("description")] string? Description,
    [property: JsonPropertyName("jellyfinPermissions")] PlanJellyfinPermissions? JellyfinPermissions,
    [property: JsonPropertyName("seerrRequestAccess")] string? SeerrRequestAccess);
public sealed record DefaultPlanRequest(
    [property: JsonPropertyName("planId")] Guid? PlanId);
public sealed record MemberRequest(
    [property: JsonPropertyName("included")] bool Included,
    [property: JsonPropertyName("planId")] Guid? PlanId);
public sealed record PaymentRequest(Guid UserId, long AmountCents, string? Note);
public sealed record AdjustmentRequest(Guid UserId, long AmountCents, string? Note);
public sealed record PaidThroughRequest(DateOnly? PaidThrough, string? Note);
public sealed record SettingsRequest(string TimeZoneId);
public sealed record BillingCycleRequest(string Cycle);
public sealed record RefundRequest(string? Note);
public sealed record UserBannerRequest(string? Title, string? Color, string? Message);
public sealed record OpeningRequest(
    string Mode, DateOnly StartDate, DateOnly? PaidThrough,
    long FirstPaymentCents, long StartingCreditCents, string? Note);
public sealed record SeerrTestRequest(
    string? Url, string? ApiKey, bool Enabled, bool AutoImportUsers);

public sealed record SeerrSettingsRequest(
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("apiKey")] string? ApiKey,
    [property: JsonPropertyName("autoImportUsers")] bool AutoImportUsers,
    [property: JsonPropertyName("clearApiKey")] bool ClearApiKey);

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
    public bool ShowRenewal { get; set; } = true;
    // "home" matches the original inline greeting; "floating" uses a fixed notification.
    public string Layout { get; set; } = "home";
    public string Icon { get; set; } = "👋";
    public string TitleTemplate { get; set; } = "Welcome, {name}!";
    public bool Gradient { get; set; } = true;
    public int WarningDays { get; set; } = 7;
    public int RefreshMinutes { get; set; } = 5;
    public string Position { get; set; } = "top";
    public string ActiveText { get; set; } = "Thanks for supporting the server! 💖 Your subscription is active through {expiration}.";
    public string ExpiringText { get; set; } = "Thanks for your support! Your subscription ends in {daysLeft} days ({expiration}).";
    public string ExpiredText { get; set; } = "Your subscription has expired. Renew to restore your subscription benefits.";
    public string UnmanagedText { get; set; } = "Subscription not configured";
    public string ActiveColor { get; set; } = "#166534";
    public string ExpiringColor { get; set; } = "#92400e";
    public string ExpiredColor { get; set; } = "#991b1b";
    public string UnmanagedColor { get; set; } = "#374151";
}

public sealed record BannerRequest(BannerSettings Banner);

public sealed record AccountPlanRequest(Guid PlanId);
public sealed record AccountPlanReviewRequest(bool Approve);
