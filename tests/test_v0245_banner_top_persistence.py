"""Top banner must stay outside Media Bar's replaceable subtree."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANNER = (ROOT / 'Jellyfin.SubscriptionManager/Configuration/banner.js').read_text()


class TopBannerPersistence(unittest.TestCase):
    def test_anchor_is_sibling_of_home_tab_not_child_of_slideshow(self):
        placement = BANNER[BANNER.index('function homeTopPlacement()'):BANNER.index('function hasHomeRoute()')]
        self.assertIn('return {target: tab.parentElement, before: tab}', placement)
        self.assertNotIn('media.parentElement', placement)
        self.assertNotIn('root.querySelector(', placement)

    def test_temporary_hidden_home_tab_preserves_banner(self):
        placement = BANNER[BANNER.index('function homeTopPlacement()'):BANNER.index('function hasHomeRoute()')]
        self.assertIn("if (document.querySelector('#homeTab')) return null", placement)
        ensure = BANNER[BANNER.index('function ensureMounted()'):BANNER.index('function queueMount()')]
        self.assertIn('if (!hasHomeRoute()) { remove(); return; }', ensure)
        self.assertIn('if (!placement) return;', ensure)
        self.assertNotIn('if (!onHome()) { remove(); return; }', ensure)

    def test_banner_is_not_moved_on_every_media_redraw(self):
        ensure = BANNER[BANNER.index('function ensureMounted()'):BANNER.index('function queueMount()')]
        self.assertIn('bannerElement.nextElementSibling !== before', ensure)
        self.assertIn('target.insertBefore(bannerElement, before)', ensure)
        self.assertIn('document.body', BANNER)


if __name__ == '__main__':
    unittest.main()
