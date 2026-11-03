"""Regression check for build errors in the v0.2.4.0 GitHub release run.

This checks source contracts; a real .NET compile in CI is still authoritative.
"""
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1] / 'Jellyfin.SubscriptionManager'


class CompileRegressionTests(unittest.TestCase):
    def test_billing_partial_class_has_logging_extensions_in_scope(self):
        billing = (PROJECT / 'Services/SubscriptionService.Billing.cs').read_text()
        self.assertIn('using Microsoft.Extensions.Logging;', billing)
        self.assertIn('_logger.LogWarning(', billing)

    def test_banner_status_checks_nullable_date_before_use(self):
        service = (PROJECT / 'Services/SubscriptionService.cs').read_text()
        self.assertIn('m is not null && IsActive(m, today) && m.PaidThrough is { } paidThrough', service)
        self.assertIn('paidThrough.DayNumber - today.DayNumber', service)
        self.assertNotIn('m.PaidThrough.Value.DayNumber', service)


if __name__ == '__main__':
    unittest.main()
