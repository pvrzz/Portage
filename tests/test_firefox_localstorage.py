import json
import os
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from firefox_localstorage import decode_value, export_profile, snappy_decode, valid_origin


class FirefoxLocalStorageTest(unittest.TestCase):
    def test_snappy_literal_and_copy(self):
        self.assertEqual(snappy_decode(b'\x05\x10hello'), b'hello')
        # 12 byte result: literal 'abc', followed by 9-byte copy at offset 3
        self.assertEqual(snappy_decode(b'\x0c\x08abc\x22\x03\x00'), b'abcabcabcabc')
        with self.assertRaises(ValueError):
            snappy_decode(b'\xff\xff\xff\xff\x7f')

    def test_utf8_utf16_and_compression(self):
        self.assertEqual(decode_value('日本語'.encode(), 1, 0), '日本語')
        self.assertEqual(decode_value('日本語'.encode('utf-16-be'), 0, 0), '日本語')
        self.assertEqual(decode_value(b'\x05\x10hello', 1, 1), 'hello')
        with self.assertRaises(ValueError):
            decode_value(b'a', 1, 99)

    def test_valid_origin(self):
        self.assertTrue(valid_origin('https://example.org:443'))
        self.assertFalse(valid_origin('https://example.org^userContextId=2'))
        self.assertFalse(valid_origin('https://example.org/some/path'))
        self.assertFalse(valid_origin('javascript:alert(1)'))

    def test_export_all_offline_origins_and_permissions(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            for name, origin, value in [('https+++first.test','https://first.test','token-A'), ('https+++second.test','https://second.test','こんにちは')]:
                d=p/'storage'/'default'/name/'ls'
                d.mkdir(parents=True)
                with sqlite3.connect(d/'data.sqlite') as con:
                    con.execute('CREATE TABLE "database" (origin TEXT)')
                    con.execute('INSERT INTO "database" VALUES (?)',(origin,))
                    con.execute('CREATE TABLE data (key TEXT, utf16_length INTEGER, conversion_type INTEGER, compression_type INTEGER, last_access_time INTEGER, value BLOB)')
                    con.execute('INSERT INTO data VALUES (?,?,?,?,?,?)',('login',len(value),1,0,0,value.encode()))
                con.close()
            (p/'storage'/'default'/'idb-site'/'idb').mkdir(parents=True)
            (p/'storage'/'default'/'idb-site'/'idb'/'1.sqlite').touch()
            sites,warnings=export_profile(p)
            self.assertEqual(len(sites),2)
            self.assertFalse(warnings)
            self.assertEqual([s['origin'] for s in sites],['https://first.test','https://second.test'])
            output=p/'export.portage.json'
            script=Path(__file__).resolve().parents[1]/'tools'/'firefox_localstorage.py'
            r=subprocess.run([sys.executable,str(script),'--profile',str(p),'--output',str(output),'--plaintext'],capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual(os.stat(output).st_mode & 0o777,0o600)
            parsed=json.loads(output.read_text())
            self.assertEqual(parsed['meta']['counts']['localStorage'],2)
            self.assertEqual(parsed['meta']['unsupported']['indexedDBOrigins'],1)
            self.assertEqual(len(parsed['data']['localStorage']),2)
            self.assertNotEqual(subprocess.run([sys.executable,str(script),'--profile',str(p),'--output',str(output)],capture_output=True).returncode,0)


if __name__ == '__main__':
    unittest.main()
