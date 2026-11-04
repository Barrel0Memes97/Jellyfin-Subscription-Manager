"""Checks custom subscriber portal, authentication scopes and portal mounting."""
import unittest
from pathlib import Path
R=Path(__file__).resolve().parents[1]
M=(R/'Jellyfin.SubscriptionManager/Models/State.cs').read_text()
S=(R/'Jellyfin.SubscriptionManager/Services/SubscriptionService.Account.cs').read_text()
API=(R/'Jellyfin.SubscriptionManager/Api/SubscriptionController.cs').read_text()
JS=(R/'Jellyfin.SubscriptionManager/Configuration/SubscriptionManager.js').read_text()
HTML=(R/'Jellyfin.SubscriptionManager/Configuration/config.html').read_text()
ACCOUNT=(R/'Jellyfin.SubscriptionManager/Configuration/account.js').read_text()
BANNER=(R/'Jellyfin.SubscriptionManager/Configuration/banner.js').read_text()
class PortalCustomization(unittest.TestCase):
    def test_persisted_model_and_endpoint(self):
        self.assertIn('SubscriberPageSettings SubscriberPage',M)
        self.assertIn('Task SetSubscriberPageAsync',S)
        self.assertRegex(API,r'\[Authorize\(Policy = Policies.RequiresElevation\)\]\s*\[HttpPost\("subscriber-page"\)\]')
        self.assertIn('page = _state.SubscriberPage',S)
    def test_admin_controls_and_export(self):
        for tag in ['sm-panel-subscriber','sm-subscriber-form','sm-sp-preview','sm-sp-menu-json','sm-sp-copy']:
            self.assertIn(tag,HTML)
        self.assertIn("url:'#/home?smAccount=1'",JS)
        self.assertIn('sideMenu:true,topNavigation:',JS)
        self.assertIn("invoke('subscriber-page'",JS)
    def test_server_enforces_private_actions(self):
        self.assertIn('_state.SubscriberPage.AllowPlanRequests',S)
        self.assertIn('_state.SubscriberPage.AllowBannerCustomization',S)
        self.assertIn('SetSubscriberBannerAsync(userId.Value, request)',API)
        self.assertIn('AuthenticatedUserId()',API)
    def test_ui_displays_hides_and_links(self):
        self.assertIn("const isAccountRoute",ACCOUNT)
        self.assertIn('smAccount=1',ACCOUNT)
        self.assertIn("setting('allowPlanRequests')",ACCOUNT)
        self.assertIn("setting('allowBannerCustomization')",ACCOUNT)
        self.assertIn("setting('showTransactions')",ACCOUNT)
        self.assertIn('escapeHtml(setting(',ACCOUNT)
    def test_banner_separate_from_media_and_reflow(self):
        self.assertIn('target.prepend(bannerSlot)',BANNER)
        self.assertIn('document.body.appendChild(bannerElement)',BANNER)
        self.assertIn('.jf-home-portal',BANNER)
        self.assertIn("document.addEventListener('scroll', queueMount, true)",BANNER)
        self.assertIn('showAccountLink',BANNER)
if __name__=='__main__': unittest.main()
