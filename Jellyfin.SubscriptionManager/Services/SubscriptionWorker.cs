using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

public sealed class SubscriptionWorker : BackgroundService
{
    private readonly SubscriptionService _service;
    private readonly ILogger<SubscriptionWorker> _logger;

    public SubscriptionWorker(SubscriptionService service, ILogger<SubscriptionWorker> logger)
    {
        _service = service;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Run on startup and regularly thereafter. Billing is idempotent because
        // the paid-through/next-charge state is persisted before policy writes.
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await _service.ReconcileAsync(stoppingToken).ConfigureAwait(false); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { _logger.LogError(ex, "Subscription reconciliation failed"); }

            try { await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }
}
