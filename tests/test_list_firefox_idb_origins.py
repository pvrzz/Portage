import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from list_firefox_idb_origins import list_origins


class FirefoxIdbOriginListTest(unittest.TestCase):
    def test_origins_are_canonicalised_and_filtered(self):
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root)
            with closing(sqlite3.connect(profile / 'storage.sqlite')) as connection, connection:
                connection.execute('CREATE TABLE origin (origin TEXT, client_usages TEXT)')
                connection.executemany('INSERT INTO origin VALUES (?,?)', [
                    ('HTTPS://Example.test:443/', 'I123'),
                    ('https://example.test', 'I456'),
                    ('https://caret.test^userContextId=1', 'I789'),
                    ('https://no-idb.test', 'L1'),
                    ('moz-extension://some-uuid', 'I999'),
                    ('not a url', 'I111'),
                ])
            self.assertEqual(list_origins(profile), ['https://example.test'])


if __name__ == '__main__':
    unittest.main()
