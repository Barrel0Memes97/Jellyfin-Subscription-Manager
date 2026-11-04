"""Security and integration contracts for subscriber self-service in 0.2.5.0."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'Jellyfin.SubscriptionManager'
CONTROLLER = (APP / 'Api/SubscriptionController.cs').read_text()
SERVICE = (APP / 'Services/SubscriptionService.Account.cs').read_text()
ADMIN = (APP / 'Configuration/SubscriptionManager.js').read_text()
HTML = (APP / 'Configuration/config.html').read_text()
WEB = (APP / 'Configuration/account.js').read_text()
PROJECT = (APP / 'Jellyfin.SubscriptionManager.csproj').read_text()
MIDDLEWARE = (APP / 'Services/BannerInjectionStartupFilter.cs').read_text()
MODEL = (APP / 'Models/State.cs').read_text()
BANNER = (APP / 'Configuration/banner.js').read_text()

class SubscriberPortalTests(unittest.TestCase):
    def test_client_is_injected_with_the_banner_without_administrator_pages(self):
        self.assertIn('Configuration/account.js', PROJECT)
        self.assertIn('account.js?v={version}', MIDDLEWARE)
        self.assertIn('banner.js?v={version}', MIDDLEWARE)
        self.assertIn('window.__subscriptionManagerOpenAccount', WEB)
        self.assertIn('My Subscription', WEB)
        self.assertIn('window.__subscriptionManagerOpenAccount?.()', BANNER)

    def test_self_endpoints_resolve_user_claim_and_never_accept_user_id(self):
        self.assertIn('User.FindFirst("Jellyfin-UserId")', CONTROLLER)
        for path in ['account/me', 'account/plan-request', 'account/banner']:
            self.assertIn(f'[HttpGet("{path}")]' if path.endswith('/me') else f'[HttpPost("{path}")]', CONTROLLER)
        self.assertIn('[Authorize]\n    [HttpGet("account/me")]', CONTROLLER)
        self.assertIn('GetAccountAsync(userId.Value, ct)', CONTROLLER)
        self.assertIn('RequestPlanChangeAsync(userId.Value, request)', CONTROLLER)
        self.assertIn('SetSubscriberBannerAsync(userId.Value, request)', CONTROLLER)
        self.assertNotIn('[AllowAnonymous]\n    [HttpGet("account/me")]', CONTROLLER)
        self.assertIn('[Authorize(Policy = Policies.RequiresElevation)]\n    [HttpPost("account/requests/{userId:guid}/review")]', CONTROLLER)

    def test_member_data_is_private_and_balance_cannot_be_modified(self):
        self.assertIn('Where(t => t.UserId == userId)', SERVICE)
        self.assertIn('Take(100)', SERVICE)
        self.assertIn('Where(p => p.Enabled || p.Id == member?.PlanId)', SERVICE)
        self.assertNotIn('AddLedger(', SERVICE)
        self.assertNotIn('BalanceCents =', SERVICE)
        self.assertNotIn('CashAmountCents =', SERVICE)
        self.assertNotIn('_state.Seerr.ApiKey', SERVICE)

    def test_request_is_not_an_immediate_permission_change(self):
        request = SERVICE.split('public async Task RequestPlanChangeAsync',1)[1].split('public async Task ReviewPlanChangeAsync',1)[0]
        self.assertIn('if (member?.Included != true)', request)
        self.assertIn('p.Enabled', request)
        self.assertIn('member.PendingPlanId = plan.Id;', request)
        self.assertNotIn('member.PlanId = plan.Id;', request)
        self.assertNotIn('ApplyAccessAsync', request)
        self.assertNotIn('SyncSeerrAsync', request)
        approval = SERVICE.split('public async Task ReviewPlanChangeAsync',1)[1]
        self.assertIn('member.PlanId = plan.Id', approval)
        self.assertIn('await ReconcileLockedAsync', approval)
        self.assertIn('await SyncSeerrAsync()', approval)
        self.assertIn('member.PendingPlanRequestedUtc = null', approval)

    def test_admin_review_queue_and_safe_plan_overrides(self):
        self.assertIn('PendingPlanId', MODEL)
        self.assertIn('PendingPlanRequestedUtc', MODEL)
        self.assertIn('id="sm-plan-requests"', HTML)
        self.assertIn('account/requests/', ADMIN)
        self.assertIn('data-plan-review="approve"', ADMIN)
        self.assertIn('data-plan-review="reject"', ADMIN)
        self.assertIn('pendingPlanRequestedUtc', (APP / 'Services/SubscriptionService.cs').read_text())

if __name__ == '__main__':
    unittest.main()
