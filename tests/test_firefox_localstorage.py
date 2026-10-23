import base64
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from firefox_localstorage import (
    decode_value, export_profile, firefox_profile_in_use, normalize_origin, snappy_decode, valid_origin,
)

try:
    import cryptography  # noqa: F401  (only needed for the encryption test)
    HAVE_CRYPTOGRAPHY = True
except ImportError:
    HAVE_CRYPTOGRAPHY = False

SCRIPT = Path(__file__).resolve().parents[1] / 'tools' / 'firefox_localstorage.py'


def write_ls_origin(profile, directory_name, origin, items):
    ls = Path(profile) / 'storage' / 'default' / directory_name / 'ls'
    ls.mkdir(parents=True)
    with closing(sqlite3.connect(ls / 'data.sqlite')) as con, con:
        con.execute('CREATE TABLE "database" (origin TEXT)')
        con.execute('INSERT INTO "database" VALUES (?)', (origin,))
        con.execute(
            'CREATE TABLE data (key TEXT, utf16_length INTEGER, conversion_type INTEGER, '
            'compression_type INTEGER, last_access_time INTEGER, value BLOB)'
        )
        for key, value in items.items():
            con.execute('INSERT INTO data VALUES (?,?,?,?,?,?)', (key, len(value), 1, 0, 0, value.encode()))


def make_profile(root):
    profile = Path(root) / 'profile'
    write_ls_origin(profile, 'https+++first.test', 'https://first.test', {'login': 'token-A'})
    return profile


class FirefoxLocalStorageTest(unittest.TestCase):
    def test_snappy_literal_and_copy(self):
        self.assertEqual(snappy_decode(b'\x05\x10hello'), b'hello')
        # 12 byte result: literal 'abc', followed by 9-byte copy at offset 3
        self.assertEqual(snappy_decode(b'\x0c\x08abc\x22\x03\x00'), b'abcabcabcabc')
        with self.assertRaises(ValueError):
            snappy_decode(b'\xff\xff\xff\xff\x7f')

    def test_utf8_utf16_and_compression(self):
        self.assertEqual(decode_value('日本語'.encode(), 1, 0), '日本語')
        self.assertEqual(decode_value('日本語', 1, 0), '日本語')
        self.assertEqual(decode_value('日本語'.encode('utf-16-be'), 0, 0), '日本語')
        self.assertEqual(decode_value(b'\x05\x10hello', 1, 1), 'hello')
        with self.assertRaises(ValueError):
            decode_value(b'a', 1, 99)

    def test_valid_origin(self):
        self.assertTrue(valid_origin('https://example.org:443'))
        self.assertFalse(valid_origin('https://example.org^userContextId=2'))
        self.assertFalse(valid_origin('https://example.org/some/path'))
        self.assertFalse(valid_origin('javascript:alert(1)'))

    def test_origin_normalization_matches_chromium_url_parser(self):
        self.assertEqual(normalize_origin('HTTPS://Example.ORG:443/'), 'https://example.org')
        self.assertEqual(normalize_origin('http://Example.org:80'), 'http://example.org')
        self.assertEqual(normalize_origin('https://example.org:8443'), 'https://example.org:8443')
        self.assertEqual(normalize_origin('https://[::1]:443'), 'https://[::1]')
        self.assertIsNone(normalize_origin('https://例え.jp'))  # Firefox stores punycode
        self.assertIsNone(normalize_origin('https://example.org^userContextId=1'))
        self.assertIsNone(normalize_origin('https://[::1'))
        self.assertIsNone(normalize_origin('https://example.org:not-a-port'))

    def test_export_all_offline_origins_and_permissions(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            write_ls_origin(p, 'https+++first.test', 'https://first.test', {'login': 'token-A'})
            write_ls_origin(p, 'https+++second.test', 'https://second.test', {'login': 'こんにちは'})
            (p / 'storage' / 'default' / 'idb-site' / 'idb').mkdir(parents=True)
            (p / 'storage' / 'default' / 'idb-site' / 'idb' / '1.sqlite').touch()
            sites, warnings = export_profile(p)
            self.assertEqual(len(sites), 2)
            self.assertFalse(warnings)
            self.assertEqual([s['origin'] for s in sites], ['https://first.test', 'https://second.test'])
            output = p / 'export.portage.json'
            result = subprocess.run(
                [sys.executable, str(SCRIPT), '--profile', str(p), '--output', str(output), '--plaintext'],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
            parsed = json.loads(output.read_text())
            self.assertEqual(parsed['meta']['counts']['localStorage'], 2)
            self.assertEqual(parsed['meta']['unsupported']['indexedDBOrigins'], 1)
            self.assertEqual(len(parsed['data']['localStorage']), 2)
            # Existing output is never overwritten, even by the encrypted path.
            self.assertNotEqual(subprocess.run(
                [sys.executable, str(SCRIPT), '--profile', str(p), '--output', str(output)],
                capture_output=True,
            ).returncode, 0)

    def test_export_normalizes_duplicate_and_invalid_origins(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            write_ls_origin(p, 'https+++upper.test', 'HTTPS://Upper.TEST:443/', {'k': 'v'})
            write_ls_origin(p, 'https+++canonical.test', 'https://upper.test', {'k': 'v'})
            write_ls_origin(p, 'https+++container.test', 'https://container.test^userContextId=1', {'k': 'v'})
            sites, warnings = export_profile(p)
            self.assertEqual([s['origin'] for s in sites], ['https://upper.test'])
            self.assertEqual(len(warnings), 2)

    def test_output_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            profile = make_profile(p)
            victim = p / 'victim'
            victim.mkdir()
            output = p / 'export.portage.json'
            os.symlink(victim / 'created.json', output)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), '--profile', str(profile), '--output', str(output), '--plaintext'],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((victim / 'created.json').exists())
            self.assertTrue(output.is_symlink())

    def test_firefox_lock_detection(self):
        with tempfile.TemporaryDirectory() as t:
            profile = make_profile(Path(t))
            self.assertFalse(firefox_profile_in_use(profile))
            lock = profile / '.parentlock'
            lock.write_bytes(b'')
            # A stale lock file alone does not count as a running profile.
            self.assertFalse(firefox_profile_in_use(profile))
            descriptor = os.open(lock, os.O_RDONLY)
            try:
                self.assertTrue(firefox_profile_in_use(profile))
            finally:
                os.close(descriptor)
            self.assertFalse(firefox_profile_in_use(profile))
            # Legacy `lock` symlinks encode the owner PID instead of holding
            # an open descriptor; a live PID must still be detected.
            lock.unlink()
            legacy = profile / 'lock'
            os.symlink(f'somehost:{os.getpid()}', legacy)
            self.assertTrue(firefox_profile_in_use(profile))
            legacy.unlink()
            os.symlink('somehost:99999999', legacy)
            self.assertFalse(firefox_profile_in_use(profile))

    def test_cli_refuses_a_running_profile(self):
        with tempfile.TemporaryDirectory() as t:
            profile = make_profile(Path(t))
            output = Path(t) / 'export.portage.json'
            lock = profile / '.parentlock'
            lock.write_bytes(b'')
            descriptor = os.open(lock, os.O_RDONLY)
            try:
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), '--profile', str(profile), '--output', str(output),
                     '--plaintext'],
                    capture_output=True, text=True,
                )
            finally:
                os.close(descriptor)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('close Firefox', result.stderr)
            self.assertFalse(output.exists())

    @unittest.skipUnless(HAVE_CRYPTOGRAPHY, 'cryptography package is not installed')
    def test_encrypted_export_roundtrip(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        passphrase = 'synthetic-passphrase-for-test-123'
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            profile = make_profile(p)
            write_ls_origin(profile, 'https+++second.test', 'https://second.test', {'secret': 'secret-value-猫'})
            output = p / 'encrypted.portage.json'
            result = subprocess.run(
                [sys.executable, str(SCRIPT), '--profile', str(profile), '--output', str(output),
                 '--passphrase-stdin'],
                input=passphrase + '\n', capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
            raw = output.read_text()
            self.assertNotIn('secret-value', raw)
            wrapper = json.loads(raw)
            meta = wrapper['portage']
            self.assertEqual(meta['format'], 'portage-bundle-encrypted')
            self.assertEqual(meta['iterations'], 250000)
            key = hashlib.pbkdf2_hmac(
                'sha256', passphrase.encode(), base64.b64decode(meta['salt']), meta['iterations'], dklen=32,
            )
            plaintext = AESGCM(key).decrypt(
                base64.b64decode(meta['iv']), base64.b64decode(wrapper['ciphertext']), None,
            )
            inner = json.loads(plaintext)
            self.assertEqual(inner['meta']['counts']['localStorage'], 2)
            self.assertEqual(inner['data']['localStorage'][1]['items']['secret'], 'secret-value-猫')


if __name__ == '__main__':
    unittest.main()
