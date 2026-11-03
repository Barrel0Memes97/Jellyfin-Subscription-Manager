import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from update_manifest import update_manifest, PLUGIN_ID


class ManifestTests(unittest.TestCase):
    def test_first_release_and_replace(self):
        with tempfile.TemporaryDirectory() as dir_name:
            path = pathlib.Path(dir_name) / 'plugin.zip'
            path.write_bytes(b'fake plugin data')
            data = update_manifest([], path, '0.2.0.0', 'example/jf-subscriptions', 'v0.2.0.0', '2026-11-02T00:00:00+00:00')
            self.assertEqual(PLUGIN_ID, data[0]['guid'])
            self.assertEqual(32, len(data[0]['versions'][0]['checksum']))
            self.assertEqual('12.4.0.0', data[0]['versions'][0]['targetAbi'])
            self.assertEqual('https://github.com/example/jf-subscriptions/releases/download/v0.2.0.0/plugin.zip', data[0]['versions'][0]['sourceUrl'])
            again = update_manifest(data, path, '0.2.0.0', 'example/jf-subscriptions', 'v0.2.0.0', '2026-11-02T00:00:00+00:00')
            self.assertEqual(1, len(again[0]['versions']))

    def test_reject_mismatched_tag(self):
        with tempfile.TemporaryDirectory() as dir_name:
            path = pathlib.Path(dir_name) / 'plugin.zip'
            path.write_bytes(b'test')
            with self.assertRaises(ValueError):
                update_manifest([], path, '0.2.0.0', 'example/plugin', 'v0.1.0.0')


if __name__ == '__main__':
    unittest.main()
