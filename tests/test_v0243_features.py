"""v0.2.4.3 source contracts: complement Node and optional Chromium tests.
These cannot guarantee C# compilation or Jellyfin/Seerr runtime behavior.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'Jellyfin.SubscriptionManager'

def read(path):
    return (ROOT / path).read_text()


class V0243Features(unittest.TestCase):
    def test_default_plan_is_persisted_and_admin_only(self):
        model, service, api = read('Models/State.cs'), read('Services/SubscriptionService.cs'), read('Api/SubscriptionController.cs')
        self.assertIn('DefaultPlanId { get; set; }', model)
        self.assertIn('defaultPlanId = _state.DefaultPlanId', service)
        self.assertIn('SetDefaultPlanAsync(DefaultPlanRequest req)', service)
        self.assertIn('_state.DefaultPlanId = req.PlanId;', service)
        self.assertRegex(api, r'\[Authorize\(Policy = Policies.RequiresElevation\)\]\s*\[HttpPost\("plans/default"\)\]')
        self.assertIn('SetDefaultPlanAsync(req)', api)
        self.assertIn('_state.Plans.Count(p => p.Enabled) == 1', service)

    def test_checkbox_and_dropdown_enrollment_are_atomic(self):
        ui = read('Configuration/SubscriptionManager.js')
        service = read('Services/SubscriptionService.cs')
        self.assertIn('included: !!planId, planId', ui)
        self.assertIn('(t.checked ? state.defaultPlanId : null)', ui)
        self.assertIn('var chosenPlanId = req.Included && !req.PlanId.HasValue', service)
        self.assertIn('m.PlanId = chosenPlanId;', service)
        self.assertIn('m.RestorePending = true;', service)

    def test_personal_message_and_color_only_override_active(self):
        model = read('Models/State.cs')
        service = read('Services/SubscriptionService.cs')
        billing = read('Services/SubscriptionService.Billing.cs')
        banner = read('Configuration/banner.js')
        self.assertIn('BannerMessage { get; set; }', model)
        self.assertIn('member.BannerMessage = message;', billing)
        self.assertIn('customMessage = status == "active"', service)
        self.assertIn('customColor = status == "active"', service)
        self.assertIn("data.status === 'active' && (data.customMessage || '').trim()", banner)
        self.assertIn("data.status === 'active' && /^#[0-9a-f]", banner)

    def test_position_is_applied_on_actual_home_dom_and_floating(self):
        banner = read('Configuration/banner.js')
        self.assertIn('target.appendChild(bannerElement)', banner)
        self.assertIn('target.prepend(bannerSlot)', banner)
        self.assertIn("field(data.appearance || {}, 'position')", banner)
        self.assertIn('banner.style.top', banner)
        self.assertIn('banner.style.bottom', banner)

    def test_ui_new_fields(self):
        html = read('Configuration/config.html')
        js = read('Configuration/SubscriptionManager.js')
        for id_ in ('sm-default-plan-form', 'sm-default-plan', 'sm-user-banner-message',
                    'sm-user-banner-use-color', 'sm-user-banner-color',
                    'sm-b-preview-viewport', 'sm-b-preview-placement'):
            self.assertIn(f'id="{id_}"', html)
        self.assertIn("api('overview?recalculate='", js)
        self.assertIn("'plans/default'", js)
        self.assertIn('message:$(\'#sm-user-banner-message\').value', js)


if __name__ == '__main__':
    unittest.main()
