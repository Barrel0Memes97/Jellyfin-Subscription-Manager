"""Keep Jellyfin 12 web controller registration and HTML routing in sync."""
import re
import subprocess
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'Jellyfin.SubscriptionManager' / 'Configuration'


class WebControllerTests(unittest.TestCase):
    def test_html_registers_external_controller_not_inline_script(self):
        html = (WEB / 'config.html').read_text(encoding='utf-8')
        self.assertIn('data-role="page"', html)
        self.assertIn('data-controller="__plugin/SubscriptionManager.js"', html)
        self.assertNotRegex(html, r'<script(?:\s|>)')

    def test_embedded_resource_and_plugin_registration(self):
        cs = (ROOT / 'Jellyfin.SubscriptionManager' / 'Plugin.cs').read_text()
        proj = (ROOT / 'Jellyfin.SubscriptionManager' / 'Jellyfin.SubscriptionManager.csproj').read_text()
        self.assertIn('Name = "SubscriptionManager.js"', cs)
        self.assertIn('EmbeddedResourcePath = "Jellyfin.Plugin.SubscriptionManager.Configuration.SubscriptionManager.js"', cs)
        self.assertIn('<EmbeddedResource Include="Configuration/SubscriptionManager.js" />', proj)

    def test_page_binds_to_view_instance_not_global_document(self):
        js = (WEB / 'SubscriptionManager.js').read_text(encoding='utf-8')
        self.assertIn('export default function SubscriptionManagerController(page)', js)
        self.assertNotIn("document.querySelector('#subscriptionManagerPage')", js)
        self.assertIn("page.addEventListener('viewshow', onPageShown)", js)

    def test_node_ui_actions(self):
        import shutil
        if not shutil.which('node'):
            self.skipTest('Node.js not installed')
        subprocess.run(['node', str(ROOT / 'tests' / 'test_config_controller.mjs')], check=True, cwd=ROOT, timeout=15)


if __name__ == '__main__':
    unittest.main()
