"""Integration checks use temporary Git repositories, never personal captures."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/check-publication.py'

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vodalens-publication-')
        self.root = Path(self.tmp.name)
        subprocess.run(['git', 'init', '-q', self.tmp.name], check=True)
    def tearDown(self):
        self.tmp.cleanup()
    def scan(self):
        return subprocess.run(['python3', str(SCRIPT)], cwd=self.root, capture_output=True, text=True)
    def write(self, name, data):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(data)
    def test_nonignored_untracked_private_artifacts_fail(self):
        for name in ['capture.sqlite-wal', 'capture.sqlite-shm', 'download.apk', 'local-config.json']:
            with self.subTest(name=name):
                self.write(name, 'fixture')
                result = self.scan()
                self.assertEqual(1, result.returncode)
                self.assertIn('private/generated path', result.stderr)
                (self.root / name).unlink()
    def test_ignored_private_files_are_not_selected_but_force_added_files_fail(self):
        self.write('.gitignore', '*.sqlite-wal\n.env\n')
        self.write('capture.sqlite-wal', 'fixture')
        self.assertEqual(0, self.scan().returncode)
        subprocess.run(['git', 'add', '-f', 'capture.sqlite-wal'], cwd=self.root, check=True)
        self.assertEqual(1, self.scan().returncode)
    def test_opaque_refresh_assignment_and_phone_fail_without_env(self):
        token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz0123456789'
        self.write('leak.js', 'const refreshToken = "' + token + '";')
        result = self.scan()
        self.assertEqual(1, result.returncode)
        self.assertNotIn(token, result.stderr)
        self.write('leak.js', 'const phone = "04' + '12345678";')
        self.assertEqual(1, self.scan().returncode)
    def test_fixture_exemption_is_exact_and_path_scoped(self):
        self.write('tests/api.test.cjs', 'const phone = "0400' + '000001";')
        self.assertEqual(0, self.scan().returncode)
        self.write('capture.txt', '0400' + '000001')
        self.assertEqual(1, self.scan().returncode)
    def test_staged_credential_cannot_be_hidden_by_safe_working_copy(self):
        self.write('file.txt', 'v1.' + 'A1b2C3d4' * 6)
        subprocess.run(['git', 'add', 'file.txt'], cwd=self.root, check=True)
        self.write('file.txt', 'safe working contents')
        self.assertEqual(1, self.scan().returncode)

if __name__ == '__main__':
    unittest.main()
