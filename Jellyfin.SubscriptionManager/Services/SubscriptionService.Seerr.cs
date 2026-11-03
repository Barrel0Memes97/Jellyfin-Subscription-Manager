using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.SubscriptionManager.Models;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

public sealed partial class SubscriptionService
{
    // Seerr permission flags from seerr-team/seerr server/lib/permissions.ts.
    // Deliberately exclude admin/manager, issue, view, vote, and other privileges.
    private const int SeerrAdmin = 2;
    private const int SeerrManageUsers = 8;
    private const int SeerrManageRequests = 16;
    private const int SeerrRequest = 32;
    private const int SeerrRequestMask = 32 | 128 | 256 | 512 | 1024 | 2048 | 4096 | 8192 |
        32768 | 65536 | 131072 | 262144 | 524288 | 8388608 | 16777216 | 33554432;

    private sealed record SeerrMember(Guid UserId, bool Included, bool Active,
        string RequestAccess, int? OriginalBits);

    public async Task SetSeerrSettingsAsync(SeerrSettingsRequest request)
    {
        var url = (request.Url ?? string.Empty).Trim().TrimEnd('/');
        if (!string.IsNullOrWhiteSpace(url) && (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrWhiteSpace(uri.UserInfo) || !string.IsNullOrWhiteSpace(uri.Query) ||
            !string.IsNullOrWhiteSpace(uri.Fragment)))
            throw new ArgumentException("Enter the Seerr HTTP(S) base URL (no API path, query, or password).");
        if ((request.ApiKey ?? string.Empty).Length > 512)
            throw new ArgumentException("Seerr API key is too long.");

        await _seerrGate.WaitAsync().ConfigureAwait(false);
        try
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var old = _state.Seerr;
                var key = request.ClearApiKey ? string.Empty :
                    string.IsNullOrWhiteSpace(request.ApiKey) ? old.ApiKey : request.ApiKey.Trim();
                if (request.Enabled && (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(key)))
                    throw new ArgumentException("Enter a Seerr URL and API key before enabling synchronization.");
                _state.Seerr = new SeerrSettings
                {
                    Enabled = request.Enabled,
                    Url = url,
                    ApiKey = key,
                    AutoImportUsers = request.AutoImportUsers
                };
                Save();
                _seerrStatusMessage = request.Enabled
                    ? "Configured; synchronization will run on the next check"
                    : "Disabled (existing Seerr permissions are not modified while disabled)";
            }
            finally { _gate.Release(); }
        }
        finally { _seerrGate.Release(); }
    }

    public async Task<string> TestSeerrAsync(CancellationToken ct = default)
    {
        SeerrSettings settings;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            settings = CopySeerrSettings();
        }
        finally { _gate.Release(); }
        if (string.IsNullOrWhiteSpace(settings.Url) || string.IsNullOrWhiteSpace(settings.ApiKey))
            throw new InvalidOperationException("Save the Seerr URL and API key first.");
        using var client = _httpClientFactory.CreateClient("SubscriptionManager.Seerr");
        using var result = await SendSeerrAsync(client, settings, HttpMethod.Get, "/user?take=1&skip=0", null, ct);
        result.EnsureSuccessStatusCode();
        return "Seerr connected and authorized (HTTP " + (int)result.StatusCode + ").";
    }

    private SeerrSettings CopySeerrSettings() => new()
    {
        Enabled = _state.Seerr.Enabled,
        Url = _state.Seerr.Url,
        ApiKey = _state.Seerr.ApiKey,
        AutoImportUsers = _state.Seerr.AutoImportUsers
    };

    private static async Task<HttpResponseMessage> SendSeerrAsync(
        HttpClient http, SeerrSettings settings, HttpMethod method, string path, object? data,
        CancellationToken ct)
    {
        using var message = new HttpRequestMessage(method, settings.Url.TrimEnd('/') + "/api/v1" + path);
        message.Headers.TryAddWithoutValidation("X-Api-Key", settings.ApiKey);
        message.Headers.Accept.ParseAdd("application/json");
        if (data is not null)
            message.Content = new StringContent(JsonSerializer.Serialize(data), Encoding.UTF8, "application/json");
        return await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
    }

    private static async Task<JsonDocument> ReadJsonAsync(HttpResponseMessage response, CancellationToken ct)
    {
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
    }

    private static int RequireInteger(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || !value.TryGetInt32(out var number))
            throw new InvalidDataException("Invalid Seerr response: missing " + property);
        return number;
    }

    private async Task<(int Id, int PermissionBits)?> GetSeerrUserAsync(
        HttpClient client, SeerrSettings settings, Guid jellyfinUserId, CancellationToken ct)
    {
        using var userResponse = await SendSeerrAsync(client, settings, HttpMethod.Get,
            "/user/jellyfin/" + jellyfinUserId.ToString("N"), null, ct).ConfigureAwait(false);
        if (userResponse.StatusCode == HttpStatusCode.NotFound) return null;
        using var doc = await ReadJsonAsync(userResponse, ct).ConfigureAwait(false);
        var id = RequireInteger(doc.RootElement, "id");
        using var permissionResponse = await SendSeerrAsync(client, settings, HttpMethod.Get,
            "/user/" + id + "/settings/permissions", null, ct).ConfigureAwait(false);
        using var permissionDoc = await ReadJsonAsync(permissionResponse, ct).ConfigureAwait(false);
        return (id, RequireInteger(permissionDoc.RootElement, "permissions"));
    }

    /// <summary>Use only the associated Jellyfin UUID; never assume matching usernames.</summary>
    public async Task SyncSeerrAsync(CancellationToken ct = default)
    {
        await _seerrGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            SeerrSettings settings;
            SeerrMember[] members;
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                settings = CopySeerrSettings();
                var today = Today();
                members = _state.Memberships.Select(m =>
                {
                    var plan = _state.Plans.FirstOrDefault(p => p.Id == m.PlanId);
                    var mode = m.Included ? plan?.SeerrRequestAccess ?? "inherit" : "inherit";
                    return new SeerrMember(m.UserId, m.Included,
                        m.Included && m.PaidThrough is { } through && through >= today,
                        mode, m.SeerrOriginalRequestBits);
                }).Where(m => (m.Included && m.RequestAccess != "inherit") || m.OriginalBits.HasValue)
                  .ToArray();
            }
            finally { _gate.Release(); }

            if (!settings.Enabled)
            {
                _seerrStatusMessage = "Seerr integration disabled";
                return;
            }
            if (members.Length == 0)
            {
                _seerrStatusMessage = "Seerr: no subscribers with managed request permissions";
                return;
            }

            var updated = 0;
            var missing = 0;
            var skippedPrivileged = 0;
            var errors = new List<string>();
            using var http = _httpClientFactory.CreateClient("SubscriptionManager.Seerr");
            foreach (var member in members)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    var jellyfinUser = _users.GetUserById(member.UserId);
                    if (jellyfinUser is null || HasGrantedPermission(jellyfinUser,
                        Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator)) continue;

                    var remote = await GetSeerrUserAsync(http, settings, member.UserId, ct).ConfigureAwait(false);
                    if (!remote.HasValue && settings.AutoImportUsers && member.Included &&
                        member.RequestAccess != "inherit")
                    {
                        using var imported = await SendSeerrAsync(http, settings, HttpMethod.Post,
                            "/user/import-from-jellyfin",
                            new { jellyfinUserIds = new[] { member.UserId.ToString("N") } }, ct).ConfigureAwait(false);
                        imported.EnsureSuccessStatusCode();
                        remote = await GetSeerrUserAsync(http, settings, member.UserId, ct).ConfigureAwait(false);
                    }
                    if (!remote.HasValue) { missing++; continue; }
                    var (seerrUserId, current) = remote.Value;
                    // Users with Seerr admin/management privileges cannot be safely locked down.
                    if ((current & (SeerrAdmin | SeerrManageUsers | SeerrManageRequests)) != 0)
                    {
                        skippedPrivileged++;
                        continue;
                    }

                    int original = member.OriginalBits ?? (current & SeerrRequestMask);
                    if (!member.OriginalBits.HasValue && member.Included && member.RequestAccess != "inherit")
                    {
                        // Persist original permission bits before changing Seerr.
                        await _gate.WaitAsync(ct).ConfigureAwait(false);
                        try
                        {
                            var persisted = _state.Memberships.FirstOrDefault(m => m.UserId == member.UserId);
                            if (persisted is not null && !persisted.SeerrOriginalRequestBits.HasValue)
                            {
                                persisted.SeerrOriginalRequestBits = original;
                                Save();
                            }
                        }
                        finally { _gate.Release(); }
                    }

                    var targetBits = !member.Included || member.RequestAccess == "inherit"
                        ? original
                        : member.Active && member.RequestAccess == "allow"
                            ? original | SeerrRequest
                            : 0;
                    var desired = (current & ~SeerrRequestMask) | targetBits;
                    if (current != desired)
                    {
                        using var result = await SendSeerrAsync(http, settings, HttpMethod.Post,
                            "/user/" + seerrUserId + "/settings/permissions",
                            new { permissions = desired }, ct).ConfigureAwait(false);
                        result.EnsureSuccessStatusCode();
                        updated++;
                    }
                    if (!member.Included || member.RequestAccess == "inherit")
                    {
                        await _gate.WaitAsync(ct).ConfigureAwait(false);
                        try
                        {
                            var persisted = _state.Memberships.FirstOrDefault(m => m.UserId == member.UserId);
                            if (persisted is not null && persisted.SeerrOriginalRequestBits.HasValue)
                            {
                                persisted.SeerrOriginalRequestBits = null;
                                Save();
                            }
                        }
                        finally { _gate.Release(); }
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Seerr access synchronization failed for Jellyfin user {UserId}", member.UserId);
                    errors.Add("User " + member.UserId.ToString("N")[..8] + ": " + ex.Message);
                }
            }
            _seerrStatusMessage = $"Seerr sync: {updated} updated, {missing} not imported, {errors.Count} errors" +
                $", {skippedPrivileged} privileged users skipped" +
                (errors.Count > 0 ? ". " + string.Join(" | ", errors.Take(3)) : string.Empty);
        }
        finally { _seerrGate.Release(); }
    }
}
