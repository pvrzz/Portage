import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from firefox_cookie_stream import collect


class FirefoxCookieStreamTest(unittest.TestCase):
    def _profile(self, root, rows):
        profile = Path(root) / 'profile'
        profile.mkdir()
        with closing(sqlite3.connect(profile / 'cookies.sqlite')) as connection, connection:
            connection.execute(
                'CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, '
                'expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, '
                'originAttributes TEXT)'
            )
            connection.executemany('INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?,?,?)', rows)
        return profile

    def test_expiry_is_converted_from_milliseconds_and_unsafe_cookies_are_skipped(self):
        now = time.time()
        future_ms = int((now + 3600) * 1000)
        past_ms = int((now - 3600) * 1000)
        rows = [
            # Persistent, unspecified SameSite: included, expiry seconds.
            ('future', 'v', 'example.com', '/', future_ms, 1, 1, 256, ''),
            # Already expired: the old milliseconds-vs-seconds mix-up imported these.
            ('expired', 'v', 'example.com', '/', past_ms, 1, 0, 256, ''),
            # Session cookies cannot survive the importer closing Chromium.
            ('session', 'v', 'example.com', '/', 0, 1, 0, 1, ''),
            # SameSite=None (requires Secure) and Strict map to CDP names.
            ('none_secure', 'v', 'example.com', '/', future_ms, 1, 0, 0, ''),
            ('strict', 'v', 'example.com', '/', future_ms, 1, 0, 2, ''),
            # Insecure SameSite=None is invalid and must be skipped.
            ('insecure_none', 'v', 'example.com', '/', future_ms, 0, 0, 0, ''),
            # Firefox containers/partitions carry non-empty originAttributes.
            ('partitioned', 'v', 'example.com', '/', future_ms, 1, 0, 1, '^userContextId=1'),
            # Malformed rows are skipped rather than forwarded to Chrome.
            ('bad_host', 'v', '', '/', future_ms, 1, 0, 1, ''),
            ('bad_path', 'v', 'example.com', 'not-a-path', future_ms, 1, 0, 1, ''),
        ]
        with tempfile.TemporaryDirectory() as root:
            profile = self._profile(root, rows)
            result = collect(profile)

        cookies = {cookie['name']: cookie for cookie in result['cookies']}
        self.assertEqual(set(cookies), {'future', 'none_secure', 'strict'})
        self.assertAlmostEqual(cookies['future']['expires'], now + 3600, delta=2)
        self.assertNotIn('sameSite', cookies['future'])
        self.assertEqual(cookies['none_secure']['sameSite'], 'None')
        self.assertEqual(cookies['strict']['sameSite'], 'Strict')
        self.assertEqual(result['skipped'], {
            'partitioned_or_containers': 1,
            'expired': 1,
            'session': 1,
            'invalid': 2,
            'insecure_none': 1,
        })

    def test_missing_database_is_an_error(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FileNotFoundError):
                collect(Path(root) / 'missing-profile')


if __name__ == '__main__':
    unittest.main()
