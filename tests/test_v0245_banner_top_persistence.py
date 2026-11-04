"""Compatibility regression for v0.2.4.5 test filename after new v0.2.4.6 anchor.

Some installations retain tests when extracting archives over an existing repo.
Keep this file explicitly so old assertions about #homeTab sibling mounting are
replaced even when the previous file was not deleted from Git.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANNER = (ROOT / 'Jellyfin.SubscriptionManager/Configuration/banner.js').read_text(encoding='utf-8')


class TopBannerPersistence(unittest.TestCase):
    @staticmethod
    def mount_logic():
        return BANNER.split('function ensureMounted() {', 1)[1].split('function queueMount()', 1)[0]

    def test_anchor_is_inside_visible_home_content_not_a_sibling_of_home_tab(self):
        # Old v0.2.4.5 test required homeTopPlacement(); v0.2.4.6 intentionally
        # removed it because #homeTab siblings were hidden by Jellyfin layouts.
        mount = self.mount_logic()
        self.assertIn('const target = findHomeContainer()', mount)
        self.assertIn('target.prepend(bannerSlot)', BANNER)
        self.assertNotIn('homeTopPlacement()', mount)
        self.assertNotIn('target.insertBefore(bannerElement, before)', mount)

    def test_banner_is_not_moved_on_every_media_redraw(self):
        mount = self.mount_logic()
        self.assertIn('bannerSlot.parentElement !== target || target.firstElementChild !== bannerSlot', BANNER)
        self.assertIn('target.prepend(bannerSlot)', BANNER)
        self.assertNotIn('ajax(', BANNER.split('function ensureMounted() {',1)[1].split('function queueMount()',1)[0])
        self.assertNotIn('refresh(', BANNER.split('function ensureMounted() {',1)[1].split('function queueMount()',1)[0])

    def test_temporary_hidden_home_tab_preserves_banner(self):
        mount = self.mount_logic()
        self.assertIn('if (!target) return;', mount)
        self.assertIn('findHomeContainer()', mount)
        self.assertIn('if (!hasHomeRoute()) { remove(); return; }', mount)
        # Visibility-based selector search skips cached hidden page wrappers.
        selector = BANNER.split('function findHomeContainer() {', 1)[1].split('function hasHomeRoute()', 1)[0]
        self.assertIn('.find(visiblyPresent)', selector)


if __name__ == '__main__':
    unittest.main()
