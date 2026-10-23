#!/usr/bin/env python3
"""Export ALL first-party Firefox LSNG localStorage origins as a Portage bundle.

This is deliberately an offline, read-only exporter. It never accesses network
services, Firefox cookies, passwords, or browser extension profiles.
"""
import argparse
import base64
import getpass
import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024


def snappy_decode(data: bytes) -> bytes:
    """Decode Snappy *raw block* format (not framed/streaming)."""
    pos = 0
    shift = 0
    expected = 0
    while True:
        if pos >= len(data) or shift > 63:
            raise ValueError('Invalid Snappy block length')
        b = data[pos]
        pos += 1
        expected |= (b & 127) << shift
        if not b & 128:
            break
        shift += 7
    if expected > MAX_DECOMPRESSED_BYTES:
        raise ValueError('Snappy block exceeds safety limit')
    out = bytearray()
    while pos < len(data):
        tag = data[pos]
        pos += 1
        op = tag & 3
        if op == 0:
            n = tag >> 2
            if n < 60:
                n += 1
            else:
                extra = n - 59
                if pos + extra > len(data):
                    raise ValueError('Truncated Snappy literal size')
                n = int.from_bytes(data[pos:pos+extra], 'little') + 1
                pos += extra
            if pos + n > len(data) or len(out) + n > expected:
                raise ValueError('Invalid Snappy literal')
            out += data[pos:pos+n]
            pos += n
        else:
            if op == 1:
                n = 4 + ((tag >> 2) & 7)
                if pos >= len(data):
                    raise ValueError('Truncated Snappy copy')
                offset = ((tag & 0xe0) << 3) | data[pos]
                pos += 1
            else:
                n = 1 + (tag >> 2)
                size = 2 if op == 2 else 4
                if pos + size > len(data):
                    raise ValueError('Truncated Snappy copy offset')
                offset = int.from_bytes(data[pos:pos+size], 'little')
                pos += size
            if offset <= 0 or offset > len(out) or len(out) + n > expected:
                raise ValueError('Invalid Snappy copy')
            for _ in range(n):
                out.append(out[-offset])
    if len(out) != expected:
        raise ValueError('Snappy length mismatch')
    return bytes(out)


def decode_value(value, conversion_type, compression_type) -> str:
    # Gecko LSNG stores some uncompressed UTF-8 values as SQLite TEXT.
    if isinstance(value, str):
        if conversion_type == 1 and compression_type == 0:
            return value
        raise ValueError('Unexpected SQLite TEXT value encoding')
    raw = bytes(value)
    if compression_type == 1:
        raw = snappy_decode(raw)
    elif compression_type != 0:
        raise ValueError(f'Unknown compression type: {compression_type}')
    if conversion_type == 0:
        return raw.decode('utf-16-be')
    if conversion_type == 1:
        return raw.decode('utf-8')
    raise ValueError(f'Unknown conversion type: {conversion_type}')


def normalize_origin(origin: str):
    """Return the canonical origin Chromium's URL parser will accept.

    Firefox stores origins in canonical form, but synthetic/corrupted profiles
    may use uppercase hosts or an explicit default port. Emitting those would
    make the JavaScript importer reject the whole bundle, so normalise here and
    skip origins that cannot be represented safely.
    """
    if not isinstance(origin, str) or '^' in origin or '#' in origin or '?' in origin:
        return None  # no silent loss of Firefox origin attributes / partitions
    try:
        u = urlsplit(origin)
        port = u.port
        host = u.hostname
    except ValueError:
        return None
    scheme = u.scheme.lower()
    if scheme not in ('http', 'https') or not host or u.username or u.password or u.path not in ('', '/'):
        return None
    if any(ord(ch) > 127 for ch in host):
        return None  # Firefox stores punycode; do not risk a WHATWG IDNA mismatch
    if ':' in host:
        host = f'[{host}]'
    default_port = 443 if scheme == 'https' else 80
    netloc = host if port is None or port == default_port else f'{host}:{port}'
    return f'{scheme}://{netloc}'


def valid_origin(origin: str) -> bool:
    return normalize_origin(origin) is not None


def firefox_lock_path(profile: Path):
    for name in ('.parentlock', 'lock'):
        candidate = profile / name
        try:
            os.lstat(candidate)
        except OSError:
            continue
        return candidate
    return None


def firefox_profile_in_use(profile: Path) -> bool:
    """Detect a Firefox process holding this profile's lock file open.

    Existence of .parentlock is not enough because a crash can leave a stale
    lock behind; /proc exposes the open descriptors of the running Firefox.
    Old macOS/BSD Firefox uses a `lock` symlink such as "host:1234", so fall
    back to checking that PID if the link has no resolvable target.
    """
    lock = firefox_lock_path(profile)
    if lock is None:
        return False
    if not os.path.exists(lock):
        # Dangling legacy `lock` symlink ("host:pid"). Path.resolve() does not
        # raise for it, so inspect the link target directly and check the PID.
        try:
            raw = os.readlink(lock)
        except OSError:
            return False
        match = re.search(r':(\d+)$', raw)
        if not match:
            return False
        try:
            os.kill(int(match.group(1)), 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    try:
        target = str(lock.resolve())
    except OSError:
        return False
    proc = Path('/proc')
    if proc.is_dir():
        for pid in os.listdir(proc):
            if not pid.isdigit():
                continue
            fd_dir = proc / pid / 'fd'
            try:
                descriptors = os.listdir(fd_dir)
            except OSError:
                continue
            for descriptor in descriptors:
                try:
                    linked = os.readlink(fd_dir / descriptor)
                except OSError:
                    continue
                if linked == target or linked == target + ' (deleted)':
                    return True
        return False
    try:
        probe = subprocess.run(['fuser', '-s', str(lock)], capture_output=True, timeout=3)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError('Cannot verify that Firefox is closed (no /proc and no fuser)') from exc
    if probe.returncode not in (0, 1):
        raise RuntimeError('Cannot verify that Firefox is closed (fuser failed)')
    return probe.returncode == 0


def export_profile(profile: Path):
    root = profile / 'storage' / 'default'
    if not root.is_dir():
        raise ValueError('Expected Firefox profile with storage/default directory')
    sites, warnings = [], []
    seen_origins = set()
    for db in sorted(root.glob('*/ls/data.sqlite')):
        try:
            # SQLite read-only URI avoids creating journal files or modifying profile.
            with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=3)) as conn:
                row = conn.execute('SELECT origin FROM "database" LIMIT 1').fetchone()
                origin = normalize_origin(row[0]) if row else None
                if origin is None:
                    warnings.append('Skipped partitioned or invalid origin (name omitted for privacy)')
                    continue
                if origin in seen_origins:
                    warnings.append('Skipped duplicate origin (name omitted for privacy)')
                    continue
                seen_origins.add(origin)
                entries = conn.execute('SELECT key, value, conversion_type, compression_type FROM data').fetchall()
                if not entries:
                    continue
                items = {}  # Preserve all JSON keys, including "__proto__".
                for key, value, conversion, compression in entries:
                    if not isinstance(key, str):
                        raise ValueError('Non-text localStorage key')
                    items[key] = decode_value(value, conversion, compression)
                sites.append({'origin': origin, 'items': items})
        except (sqlite3.Error, ValueError, TypeError, UnicodeError, OSError) as exc:
            warnings.append(f'Skipped unreadable/unsupported origin (details omitted): {type(exc).__name__}')
    return sites, warnings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True, help='Firefox profile folder from about:profiles')
    parser.add_argument('--output', type=Path, required=True, help='New private .portage.json bundle (contains session secrets)')
    parser.add_argument('--plaintext', action='store_true', help='DANGEROUS: disable default AES-256-GCM encryption')
    parser.add_argument('--passphrase-stdin', action='store_true', help='Read encryption passphrase from stdin instead of prompting')
    args = parser.parse_args(argv)
    profile = args.profile.expanduser().resolve()
    # Do not resolve the output path: resolving a dangling symlink would write
    # through it and defeat the no-clobber guarantee below.
    output = args.output.expanduser()
    if os.path.lexists(output):
        parser.error('Output already exists: will not overwrite sensitive data')
    if not profile.is_dir():
        parser.error('Profile directory does not exist')
    try:
        if firefox_profile_in_use(profile):
            parser.error('Firefox appears to be running with this profile; close Firefox before exporting')
    except RuntimeError as exc:
        parser.error(str(exc))
    sites, warnings = export_profile(profile)
    # Inventory unsupported IndexedDB without opening or reading any IDB records.
    # Counts, not credential-bearing names/values, go into the bundle metadata.
    idb_count = sum(1 for directory in (profile / 'storage' / 'default').glob('*/idb')
                    if directory.is_dir() and any(directory.glob('*.sqlite')))
    if not sites:
        parser.error('No compatible localStorage origins found (see warnings / profile path)')
    bundle = {
        'portage': {'format': 'portage-bundle', 'version': 1, 'source': 'firefox',
                    'generator': 'Portage offline localStorage exporter',
                    'exportedAt': datetime.now(timezone.utc).isoformat()},
        'meta': {'counts': {'localStorage': len(sites)},
                 'unsupported': {'indexedDBOrigins': idb_count}},
        'data': {'localStorage': sites},
    }
    if not args.plaintext:
        # Uses the same PBKDF2 + AES-GCM wire format as the extension itself.
        # Imported lazily: plaintext mode has no third-party dependencies.
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        except ImportError:
            parser.error('Encryption needs cryptography: pip install cryptography (or explicitly use --plaintext)')
        if args.passphrase_stdin:
            phrase = sys.stdin.readline().rstrip('\r\n')
        elif sys.stdin.isatty():
            phrase = getpass.getpass('Portage encryption passphrase: ')
        else:
            parser.error('Encrypted export requires a TTY, or --passphrase-stdin')
        if len(phrase) < 16:
            parser.error('Use a passphrase of at least 16 characters')
        salt, iv, iterations = os.urandom(16), os.urandom(12), 250000
        key = hashlib.pbkdf2_hmac('sha256', phrase.encode('utf8'), salt, iterations, dklen=32)
        inner = json.dumps({'meta': bundle['meta'], 'data': bundle['data']}, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        ciphertext = AESGCM(key).encrypt(iv, inner, None)
        bundle = {
            'portage': {
                'format':'portage-bundle-encrypted', 'version':1, 'source':'firefox',
                'generator': 'Portage offline localStorage exporter',
                'exportedAt': bundle['portage']['exportedAt'],
                'cipher':'AES-GCM','keyLength':256,'kdf':'PBKDF2','hash':'SHA-256',
                'iterations':iterations,'salt':base64.b64encode(salt).decode(),
                'iv':base64.b64encode(iv).decode(),
            },
            'ciphertext':base64.b64encode(ciphertext).decode(),
        }
    # Create mode 0600: no permissive intermediate file, no clobber, and never
    # follow a symlink (a dangling link would otherwise redirect the write).
    try:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    except FileExistsError:
        parser.error('Output already exists: will not overwrite sensitive data')
    except FileNotFoundError:
        parser.error(f'Output directory does not exist: {output.parent}')
    except OSError as exc:
        parser.error(f'Cannot create output file: {exc.strerror or exc}')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(bundle, out, ensure_ascii=False, separators=(',', ':'))
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    print(f'Exported {len(sites)} origins to {output} (PRIVATE, '+('UNENCRYPTED' if args.plaintext else 'AES-256-GCM encrypted')+')')
    print('The bundle may contain active login tokens. Do not upload or share it.')
    if idb_count:
        print(f'WARNING: IndexedDB exists for {idb_count} origin(s) and is NOT migrated.', file=sys.stderr)
    for warning in warnings:
        print('WARNING:', warning, file=sys.stderr)
    if warnings:
        print(f'Skipped {len(warnings)} origin(s); check warning lines.', file=sys.stderr)


if __name__ == '__main__':
    main()
