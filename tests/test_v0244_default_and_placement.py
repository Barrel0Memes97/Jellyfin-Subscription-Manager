"""Default-plan UX and original injection placement regression checks."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'Jellyfin.SubscriptionManager' / 'Configuration'

class DefaultPlanAndBannerPlacement(unittest.TestCase):
    def test_default_controls_are_prominent(self):
        html = (WEB/'config.html').read_text()
        section = html.split('id="sm-panel-plans"',1)[1].split('id="sm-panel-payments"',1)[0]
        self.assertLess(section.index('id="sm-default-plan-form"'), section.index('id="sm-plan-form"'))
        for item in ('id="sm-default-plan-current"','id="sm-users-default-plan"','data-tab="plans"'):
            self.assertIn(item, html)
        js = (WEB/'SubscriptionManager.js').read_text()
        self.assertIn('target.dataset.defaultPlan',js)
        self.assertIn("invoke('plans/default', {planId:plan.id}", js)
        self.assertIn('(t.checked ? state.defaultPlanId : null)', js)

    def test_top_anchor_uses_original_home_container(self):
        js=(WEB/'banner.js').read_text()
        self.assertIn('function findHomeContainer()', js)
        self.assertIn("'.homePageMain'", js)
        self.assertIn("'.homePage'", js)
        self.assertIn("'.homeSectionsContainer'", js)
        self.assertIn("'.mainAnimatedPage'", js)
        self.assertIn("'.pageContainer'", js)
        self.assertIn('target.prepend(bannerElement)', js)
        self.assertIn('target.appendChild(bannerElement)', js)
        self.assertNotIn('target.insertBefore(bannerElement, before)', js)
        self.assertIn('if (!hasHomeRoute()) { remove(); return; }', js)

if __name__ == '__main__': unittest.main()
