"""Prevent known Jellyfin 12.4 API regressions (not a substitute for dotnet build)."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / 'Jellyfin.SubscriptionManager' / 'Services' / 'SubscriptionService.cs'
PROJECT = ROOT / 'Jellyfin.SubscriptionManager' / 'Jellyfin.SubscriptionManager.csproj'


class SourceCompatibilityTests(unittest.TestCase):
    def test_uses_supported_collection_based_permissions(self):
        source = SERVICE.read_text(encoding='utf-8')
        self.assertNotRegex(source, r'\b(?:user|u)\.HasPermission\s*\(')
        self.assertRegex(source, r'\.Permissions\.Any\s*\(')
        self.assertIn('permission.Kind == kind && permission.Value', source)
        self.assertIn('HasGrantedPermission(user, PermissionKind.IsAdministrator)', source)
        self.assertIn('HasGrantedPermission(user, PermissionKind.IsDisabled)', source)

    def test_restores_original_schedules_for_active_subscribers(self):
        source = SERVICE.read_text(encoding='utf-8')
        self.assertIn('member.OriginalSchedulesCaptured ? Restore(member, user.Id)', source)

    def test_version_and_runtime(self):
        project = PROJECT.read_text(encoding='utf-8')
        self.assertIn('<TargetFramework>net10.0</TargetFramework>', project)
        self.assertIn('<Version>0.2.4.6</Version>', project)
        self.assertIn('Version="12.4.0"', project)


if __name__ == '__main__':
    unittest.main()
