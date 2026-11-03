"""Regression checks for 0.2.3 server DTOs, plan permission safety and Seerr connection."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'Jellyfin.SubscriptionManager'

class PlanSeerrSourceTests(unittest.TestCase):
    def test_plan_response_has_explicit_camel_case_and_no_raw_plan_entities(self):
        c = (ROOT / 'Services' / 'SubscriptionService.cs').read_text()
        self.assertIn('id = p.Id, name = p.Name, description = p.Description', c)
        self.assertIn('monthlyCents = p.MonthlyCents, enabled = p.Enabled', c)
        self.assertNotIn('plans = _state.Plans.OrderBy(p => p.Name).ToArray()', c)

    def test_existing_data_file_kept_and_new_properties_optional(self):
        c = (ROOT / 'Services' / 'SubscriptionService.cs').read_text()
        m = (ROOT / 'Models' / 'State.cs').read_text()
        self.assertIn('JsonSerializer.Deserialize<SubscriptionState>(File.ReadAllText(_path), _json)', c)
        self.assertIn('plan.JellyfinPermissions ??= new PlanJellyfinPermissions()', c)
        self.assertIn('OriginalPermissions', m)
        self.assertIn('SeerrOriginalRequestBits', m)

    def test_no_admin_permission_grants_and_originals_restored(self):
        c = (ROOT / 'Services' / 'SubscriptionService.cs').read_text()
        self.assertIn('member.OriginalPermissions[key] = current;', c)
        self.assertIn('WritePolicySetting(policy, key, original);', c)
        self.assertNotIn('policy.IsAdministrator =', c)
        self.assertNotIn('policy.IsDisabled =', c)

    def test_remote_seerr_credentials_are_not_exposed_in_overview(self):
        c = (ROOT / 'Services' / 'SubscriptionService.cs').read_text()
        self.assertIn('hasApiKey = !string.IsNullOrWhiteSpace', c)
        self.assertNotIn('apiKey = _state.Seerr.ApiKey', c)
        remote = (ROOT / 'Services' / 'SubscriptionService.Seerr.cs').read_text()
        self.assertIn('X-Api-Key', remote)
        self.assertIn('/user/jellyfin/', remote)
        self.assertIn('SeerrRequestMask', remote)
        self.assertIn('SeerrAdmin | SeerrManageUsers | SeerrManageRequests', remote)
        self.assertIn('"/user/import-from-jellyfin"', remote)

    def test_routes_are_admin_only_and_navigation_present(self):
        api = (ROOT / 'Api' / 'SubscriptionController.cs').read_text()
        for path in ['seerr/settings', 'seerr/test', 'seerr/sync']:
            self.assertIn('HttpPost("' + path + '")', api)
        html = (ROOT / 'Configuration' / 'config.html').read_text()
        for element in ['sm-plan-desc', 'sm-plan-seerr', 'sm-seerr-url', 'sm-seerr-key', 'sm-seerr-form']:
            self.assertIn('id="' + element + '"', html)

if __name__ == '__main__':
    unittest.main()
