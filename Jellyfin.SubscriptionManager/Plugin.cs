using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SubscriptionManager;

public sealed class PluginConfiguration : BasePluginConfiguration { }

public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public override Guid Id => Guid.Parse("d86ea639-fd20-458d-b4ae-ac8b74c8c0ca");
    public override string Name => "Subscription Manager";
    public override string Description => "Admin-managed Jellyfin subscription plans, prepaid balances and playback access.";

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer) { }

    public IEnumerable<PluginPageInfo> GetPages() => new[]
    {
        new PluginPageInfo
        {
            Name = "Subscription Manager",
            DisplayName = "Subscription Manager",
            EnableInMainMenu = true,
            EmbeddedResourcePath = "Jellyfin.Plugin.SubscriptionManager.Configuration.config.html"
        },
        // Served by Jellyfin at /web/ConfigurationPage?name=SubscriptionManager.js.
        // The data-controller attribute loads it as an ES module for each page instance.
        new PluginPageInfo
        {
            Name = "SubscriptionManager.js",
            EmbeddedResourcePath = "Jellyfin.Plugin.SubscriptionManager.Configuration.SubscriptionManager.js"
        }
    };
}
