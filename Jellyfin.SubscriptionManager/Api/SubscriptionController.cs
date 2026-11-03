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
    public async Task<IActionResult> Overview(CancellationToken ct) => Ok(await _service.OverviewAsync(ct));

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("plans")]
    public async Task<IActionResult> UpsertPlan([FromBody] PlanRequest req)
    {
        try { await _service.UpsertPlanAsync(req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [Authorize(Policy = Policies.RequiresElevation)]
    [HttpPost("users/{userId:guid}")]
    public async Task<IActionResult> SetMember(Guid userId, [FromBody] MemberRequest req)
    {
        try { await _service.SetMemberAsync(userId, req); return Ok(new { success = true }); }
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
        try { await _service.SetPaidThroughAsync(userId, req); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
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
    [HttpPost("banner")]
    public async Task<IActionResult> SetBanner([FromBody] BannerRequest request)
    {
        try { await _service.SetBannerAsync(request.Banner); return Ok(new { success = true }); }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }
}
