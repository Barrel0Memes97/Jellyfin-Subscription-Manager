"""Version 0.2.4.2 banner lifecycle regression contracts.
The optional real Chromium integration test is scripts/check_banner_lifecycle.py.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANNER = (ROOT / 'Jellyfin.SubscriptionManager/Configuration/banner.js').read_text()
MIDDLEWARE = (ROOT / 'Jellyfin.SubscriptionManager/Services/BannerInjectionStartupFilter.cs').read_text()
PROJECT = (ROOT / 'Jellyfin.SubscriptionManager/Jellyfin.SubscriptionManager.csproj').read_text()


class BannerLifecycleTests(unittest.TestCase):
    def test_version_and_automatic_cache_busting(self):
        self.assertIn('<Version>0.2.5.0</Version>', PROJECT)
        self.assertIn('Assembly.GetName().Version', MIDDLEWARE)
        self.assertIn('banner.js?v={version}', MIDDLEWARE)

    def test_observe_nested_home_render_not_only_body_children(self):
        self.assertIn('childList:true, subtree:true, attributes:true', BANNER)
        self.assertIn("attributeFilter:['class', 'style', 'hidden', 'aria-hidden']", BANNER)
        self.assertIn('const observer = new MutationObserver', BANNER)
        self.assertIn('queueMount();', BANNER)
        self.assertIn("document.addEventListener('HISTORY_UPDATE'", BANNER)
        self.assertIn("document.addEventListener('viewshow'", BANNER)

    def test_find_current_home_and_preserve_single_element(self):
        self.assertIn("document.querySelectorAll('#homeTab')", BANNER)
        self.assertIn('homeSectionsContainer', BANNER)
        self.assertIn('bannerElement.parentElement !== target', BANNER)
        self.assertIn('target.prepend(bannerElement)', BANNER)
        self.assertIn('if (!bannerElement) {', BANNER)
        self.assertNotIn('document.getElementById(bannerId)?.remove()', BANNER)

    def test_dismissal_and_user_identity_are_not_reset_by_dom_changes(self):
        self.assertIn('Date.now() < dismissedUntil', BANNER)
        self.assertIn('dismissedUntil = Date.now() + refreshMs', BANNER)
        self.assertIn('if (identity !== lastIdentity)', BANNER)
        self.assertIn('if (identity === lastIdentity && api()?.getCurrentUserId?.() === identity)', BANNER)

    def test_mount_is_not_an_api_request(self):
        mount = BANNER[BANNER.index('function ensureMounted()'):BANNER.index('function queueMount()')]
        self.assertNotIn('ajax(', mount)
        self.assertNotIn('refresh(', mount)
        self.assertIn('lastData', mount)


if __name__ == '__main__':
    unittest.main()
