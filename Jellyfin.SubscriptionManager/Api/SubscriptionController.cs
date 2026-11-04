using Jellyfin.Plugin.SubscriptionManager.Models;
using Jellyfin.Plugin.SubscriptionManager.Services;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Reflection;

namespace Jellyfin.Plugin.SubscriptionManager.Api;

[ApiController]
[Route("SubscriptionManager")]
public sealed class SubscriptionController : ControllerBase
{
    private readonly SubscriptionService _service;
    public SubscriptionController(SubscriptionService service) => _service = service;

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpGet("overview")]
    public async Task<IActionResult> Overview(CancellationToken ct, [FromQuery] bool recalculate = true) =>
        Ok(await _service.OverviewAsync(ct, recalculate));

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("plans")]
    public async Task<IActionResult> UpsertPlan([FromBody] PlanRequest req)
    {
        try { await _service.UpsertPlanAsync(req); await _service.SyncSeerrAsync(); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("plans/default")]
    public async Task<IActionResult> SetDefaultPlan([FromBody] DefaultPlanRequest req)
    {
        try { await _service.SetDefaultPlanAsync(req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("users/{userId:guid}")]
    public async Task<IActionResult> SetMember(Guid userId, [FromBody] MemberRequest req)
    {
        try { await _service.SetMemberAsync(userId, req); await _service.SyncSeerrAsync(); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("payments")]
    public async Task<IActionResult> Deposit([FromBody] PaymentRequest req)
    {
        try { await _service.DepositAsync(req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("adjustments")]
    public async Task<IActionResult> Adjust([FromBody] AdjustmentRequest req)
    {
        try { await _service.AdjustAsync(req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("users/{userId:guid}/expiration")]
    public async Task<IActionResult> SetExpiration(Guid userId, [FromBody] PaidThroughRequest req)
    {
        try { await _service.SetPaidThroughAsync(userId, req); await _service.SyncSeerrAsync(); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("users/{userId:guid}/billing-cycle")]
    public async Task<IActionResult> BillingCycle(Guid userId, [FromBody] BillingCycleRequest req)
    {
        try { await _service.SetBillingCycleAsync(userId, req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("users/{userId:guid}/opening")]
    public async Task<IActionResult> Opening(Guid userId, [FromBody] OpeningRequest req)
    {
        try { await _service.RecordOpeningAsync(userId, req); await _service.SyncSeerrAsync(); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("users/{userId:guid}/banner")]
    public async Task<IActionResult> UserBanner(Guid userId, [FromBody] UserBannerRequest req)
    {
        try { await _service.SetUserBannerAsync(userId, req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("transactions/{transactionId:guid}/refund")]
    public async Task<IActionResult> Refund(Guid transactionId, [FromBody] RefundRequest req)
    {
        try { await _service.RefundAsync(transactionId, req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("sync/statuses")]
    public async Task<IActionResult> SyncStatuses(CancellationToken ct)
    {
        await _service.SyncStatusesAsync(ct);
        return Ok(new { success = true, message = _service.LastManualSyncMessage });
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("settings")]
    public async Task<IActionResult> Settings([FromBody] SettingsRequest req)
    {
        try { await _service.SetSettingsAsync(req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("sync")]
    public async Task<IActionResult> Sync(CancellationToken ct)
    {
        await _service.ReconcileAsync(ct);
        return Ok(new { success = true });
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("seerr/settings")]
    public async Task<IActionResult> SetSeerrSettings([FromBody] SeerrSettingsRequest req)
    {
        try { await _service.SetSeerrSettingsAsync(req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("seerr/test")]
    public async Task<IActionResult> TestSeerr([FromBody] SeerrTestRequest req, CancellationToken ct)
    {
        try
        {
            var result = await _service.TestSeerrAsync(req, ct);
            return Ok(new { message = result.Message, automaticallySaved = result.AutomaticallySaved });
        }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        { return StatusCode(502, new { message = "Seerr connection failed: " + ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("seerr/sync")]
    public async Task<IActionResult> SyncSeerr(CancellationToken ct)
    {
        await _service.SyncSeerrAsync(ct);
        return Ok(new { message = _service.SeerrStatusMessage });
    }

    // Subscriber-facing endpoints: identity always comes from an authenticated
    // Jellyfin claim, never a user ID submitted by the browser.
    private Guid? AuthenticatedUserId()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) && id != Guid.Empty ? id : null;
    }

    [Authorize]
    [HttpGet("account/me")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> Account(CancellationToken ct)
    {
        var userId = AuthenticatedUserId();
        if (!userId.HasValue) return Unauthorized();
        try { return Ok(await _service.GetAccountAsync(userId.Value, ct)); }
        catch (ArgumentException) { return NotFound(); }
    }

    [Authorize]
    [HttpPost("account/plan-request")]
    public async Task<IActionResult> RequestPlanChange([FromBody] AccountPlanRequest request)
    {
        var userId = AuthenticatedUserId();
        if (!userId.HasValue) return Unauthorized();
        try { await _service.RequestPlanChangeAsync(userId.Value, request); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize]
    [HttpPost("account/banner")]
    public async Task<IActionResult> UpdateMyBanner([FromBody] UserBannerRequest request)
    {
        var userId = AuthenticatedUserId();
        if (!userId.HasValue) return Unauthorized();
        try { await _service.SetSubscriberBannerAsync(userId.Value, request); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("account/requests/{userId:guid}/review")]
    public async Task<IActionResult> ReviewPlanChange(Guid userId, [FromBody] AccountPlanReviewRequest request)
    {
        try { await _service.ReviewPlanChangeAsync(userId, request); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [AllowAnonymous]
    [HttpGet("account.js")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult AccountScript()
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(
            "Jellyfin.Plugin.SubscriptionManager.Configuration.account.js");
        return stream is null ? NotFound() : File(stream, "text/javascript; charset=utf-8");
    }

    [AllowAnonymous]
    [HttpGet("banner.js")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult BannerScript()
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(
            "Jellyfin.Plugin.SubscriptionManager.Configuration.banner.js");
        return stream is null ? NotFound() : File(stream, "text/javascript; charset=utf-8");
    }

    [Authorize] // Authorization is intentionally required for account-specific data.
    [HttpGet("me")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> MyBanner(CancellationToken ct)
    {
        // Never accept a user ID from a request parameter. Only use Jellyfin's
        // authenticated identity. An admin API key with no user claim is denied.
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        if (!Guid.TryParse(claim, out var id) || id == Guid.Empty) return Unauthorized();
        try { return Ok(await _service.GetBannerForUserAsync(id, ct)); }
        catch (ArgumentException) { return NotFound(); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("subscriber-page")]
    public async Task<IActionResult> SaveSubscriberPage([FromBody] SubscriberPageRequest request)
    {
        try { await _service.SetSubscriberPageAsync(request.Page); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("banner")]
    public async Task<IActionResult> SetBanner([FromBody] BannerRequest request)
    {
        try { await _service.SetBannerAsync(request.Banner); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }
}
