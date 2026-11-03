"""Contract tests for the v0.2.4.0 settings-page and server-source additions.
These do not replace a .NET 10 compile or a live Jellyfin/Seerr integration test.
"""
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'Jellyfin.SubscriptionManager'


class IdParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if 'id' in values:
            self.ids.append(values['id'])


class V024Features(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = (ROOT / 'Api/SubscriptionController.cs').read_text()
        cls.billing = (ROOT / 'Services/SubscriptionService.Billing.cs').read_text()
        cls.service = (ROOT / 'Services/SubscriptionService.cs').read_text()
        cls.seerr = (ROOT / 'Services/SubscriptionService.Seerr.cs').read_text()
        cls.state = (ROOT / 'Models/State.cs').read_text()
        cls.banner = (ROOT / 'Configuration/banner.js').read_text()
        cls.ui = (ROOT / 'Configuration/SubscriptionManager.js').read_text()
        cls.html = (ROOT / 'Configuration/config.html').read_text()

    def test_unique_ids_and_expected_user_controls(self):
        parser = IdParser()
        parser.feed(self.html)
        self.assertEqual(len(parser.ids), len(set(parser.ids)), 'Duplicate HTML IDs can break controls')
        for id in ('sm-sync-statuses','sm-detail-cycle','sm-cycle-form','sm-opening-form',
                   'sm-opening-start','sm-opening-payment','sm-opening-credit-toggle',
                   'sm-opening-through','sm-opening-credit','sm-opening-preview',
                   'sm-user-banner-title','sm-b-preview','sm-b-preview-user',
                   'sm-b-layout','sm-b-title-template','sm-b-gradient'):
            self.assertIn(id, parser.ids, id)

    def test_friday_cycle_and_migrated_data(self):
        self.assertIn('BillingCycle { get; set; } = "legacy"', self.state)
        self.assertIn('NextFridayInFollowingMonth', self.billing)
        self.assertIn('DateTime.DaysInMonth', self.billing)
        self.assertIn('DayOfWeek.Friday', self.billing)
        self.assertIn('m?.BillingCycle', self.service)
        self.assertIn('nextChargeOn', self.service)
        self.assertIn('if (recalculate) await ReconcileLockedAsync', self.service)
        self.assertIn('overview?recalculate=', self.ui)
        self.assertIn("await refresh(field(result,'message') || 'Status sync completed without billing charges.', false)", self.ui)

    def test_receipts_are_not_double_credited(self):
        self.assertIn('if (member.OpeningRecorded)', self.billing)
        self.assertIn('CashAmountCents = request.FirstPaymentCents', self.billing)
        self.assertIn('Kind = "first payment", AmountCents = 0', self.billing)
        self.assertIn('"opening credit", request.StartingCreditCents', self.billing)
        self.assertIn('"opening allocation", -plan.MonthlyCents', self.billing)
        self.assertIn('At most 120 prepaid months', self.billing)
        self.assertIn('member.OpeningRecorded = true;', self.billing)

    def test_refunds_create_one_linked_immutable_reversal(self):
        self.assertIn('_state.Ledger.Any(x => x.RefundOf == transactionId)', self.billing)
        self.assertIn('var original = _state.Ledger.FirstOrDefault', self.billing)
        self.assertIn('AddLedger(member, "refund", checked(-original.AmountCents)', self.billing)
        self.assertIn('reversal.RefundOf = original.Id;', self.billing)
        self.assertIn('t.CashAmountCents', self.service)
        self.assertIn('data-refund=', self.ui)
        self.assertNotIn('_state.Ledger.Remove', self.billing)

    def test_seerr_test_validates_unsaved_settings_then_saves_if_appropriate(self):
        candidate = self.seerr.index('var candidate = new SeerrSettings')
        test = self.seerr.index('response.EnsureSuccessStatusCode();', candidate)
        save = self.seerr.index('_state.Seerr = candidate; Save();', test)
        self.assertLess(candidate, test)
        self.assertLess(test, save)
        self.assertIn('if (!existingValid)', self.seerr)
        self.assertIn('api(\'seerr/test\', {', self.ui)
        self.assertNotIn('api(\'seerr/test\', {})', self.ui)

    def test_banner_retains_old_welcome_style_and_preview(self):
        for phrase in ('linear-gradient', 'jf-personalized-user-banner',
                       'jf-banner-content', 'jf-banner-title', 'jf-banner-message',
                       'homePageMain', 'sm-user-banner-color'):
            self.assertIn(phrase, self.banner + self.html)
        self.assertIn('layout = b.Layout', self.service)
        self.assertIn('titleTemplate = b.TitleTemplate', self.service)
        self.assertIn('previewBanner()', self.ui)
        self.assertIn('element.checked = bool(value)', self.ui)

    def test_api_changes_are_admin_only(self):
        routes = ('billing-cycle','/opening','/banner','/refund','sync/statuses')
        for route in routes:
            self.assertIn(route, self.api)
        self.assertGreaterEqual(self.api.count('[Authorize(Policy = Policies.RequiresElevation)]'), 10)
        self.assertIn('[Authorize] // Authorization is intentionally required for account-specific data.', self.api)

if __name__ == '__main__': unittest.main()
