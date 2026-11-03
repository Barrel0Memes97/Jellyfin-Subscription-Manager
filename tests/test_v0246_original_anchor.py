"""Regression: restore the original standalone banner anchor and avoid stale pages."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANNER = (ROOT / 'Jellyfin.SubscriptionManager/Configuration/banner.js').read_text()


class OriginalBannerAnchor(unittest.TestCase):
    def test_original_selector_priority(self):
        selector_block = BANNER[BANNER.index('const homeContainerSelectors'):BANNER.index('function findHomeContainer()')]
        selectors = ['.homePageMain', '.homePage', '.homeSectionsContainer',
                     '.mainAnimatedPage', '.pageContainer']
        positions = [selector_block.index("'" + selector + "'") for selector in selectors]
        self.assertEqual(positions, sorted(positions))

    def test_top_prepends_into_real_home_container(self):
        mount = BANNER[BANNER.index('function ensureMounted()'):BANNER.index('function queueMount()')]
        self.assertIn('const target = findHomeContainer()', mount)
        self.assertIn('target.prepend(bannerElement)', mount)
        self.assertNotIn('homeTopPlacement()', mount)
        self.assertNotIn('target.insertBefore(bannerElement, before)', mount)

    def test_cached_hidden_page_is_skipped(self):
        selector = BANNER[BANNER.index('function findHomeContainer()'):BANNER.index('function hasHomeRoute()')]
        self.assertIn('.find(visiblyPresent)', selector)
        self.assertIn('activeHomeTab()', selector)
        self.assertIn("selector === '.homeSectionsContainer'", selector)

    def test_no_extra_billing_or_api_calls_to_reanchor(self):
        mount = BANNER[BANNER.index('function ensureMounted()'):BANNER.index('function queueMount()')]
        self.assertNotIn('ajax(', mount)
        self.assertNotIn('refresh(', mount)
        self.assertIn('lastData', mount)

if __name__ == '__main__':
    unittest.main()
