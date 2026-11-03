using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

public sealed class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost applicationHost)
    {
        services.AddHttpClient("SubscriptionManager.Seerr", client => client.Timeout = TimeSpan.FromSeconds(12));
        services.AddSingleton<SubscriptionService>();
        services.AddTransient<IStartupFilter, BannerInjectionStartupFilter>();
        services.AddHostedService<SubscriptionWorker>();
    }
}
