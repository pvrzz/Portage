#!/usr/bin/env python3
"""List Firefox first-party HTTP(S) IndexedDB origins using QuotaManager metadata."""
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

from firefox_localstorage import normalize_origin


def list_origins(profile):
    db = Path(profile) / 'storage.sqlite'
    if not db.is_file():
        raise FileNotFoundError(f'Missing Firefox QuotaManager storage.sqlite: {db}')
    result = []
    with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=5)) as connection:
        for origin, usage in connection.execute('SELECT origin, client_usages FROM origin'):
            if not origin or not isinstance(usage, str) or 'I' not in usage:
                continue  # no privileged schemes or origin-attribute partition flattening
            # Share the LocalStorage exporter's canonicalisation so a stray
            # uppercase/default-port origin cannot fail the whole run later.
            normalized = normalize_origin(origin)
            if normalized:
                result.append(normalized)
    return sorted(set(result))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: list_firefox_idb_origins.py PROFILE', file=sys.stderr)
        sys.exit(2)
    print(json.dumps(list_origins(sys.argv[1])))
