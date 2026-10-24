# Experimental whole-profile Firefox → Chromium LocalStorage migration

The Portage extension cannot enumerate every origin's LocalStorage via WebExtension APIs. This optional Linux companion migrates **every compatible first-party Firefox LocalStorage origin** by reading the offline Firefox profile and writing via a separate, headless Chrome/Brave session. It does **not** depend on currently open tabs, and does **not** fetch live website content during import.

**This is not complete browser-profile migration.** The LocalStorage helper does *not* migrate sessionStorage, Service Workers, Firefox Containers, partitioned LocalStorage, WebAuthn/passkeys, or device-bound session credentials. IndexedDB has a separate experimental section below with its own limitations. Login persistence cannot be guaranteed. The standard Portage extension can migrate bookmarks and cookies; this folder also adds an offline cookie companion.

## Safety / prerequisites

- Backup the Firefox and Chromium/Brave profiles first.
- Close Firefox before exporting; close Brave/Chrome before applying to its profile. The importer refuses an existing Chromium `SingletonLock`, and the tools refuse a Firefox-looking profile as the Chromium target, as well as `/` or the home directory.
- LocalStorage can contain live session tokens. **Encrypted AES-256-GCM export is the default**; use a long unique passphrase. `--plaintext` is an explicitly unsafe opt-out. Output is mode 0600. Never attach exported bundles to an issue, share them, or commit them.
- Require **Python 3** and `cryptography` for encryption (`sudo apt install python3-cryptography` on Debian), and **Node.js 22.12+**, plus Puppeteer Core (`cd tools && npm ci`). Puppeteer Core uses the existing installed Chrome/Brave and downloads no browsers.
- The exporter reports a **count of IndexedDB origins omitted** (without opening their records); use the IndexedDB section below if you need them.
- Import is **merge/upsert**: values with matching LocalStorage keys in the target are overwritten. Use a fresh Chromium profile where possible. Failed sites are reported and attempted writes are rolled back within the page when possible; this does not provide cross-origin atomic transactions. If an import is interrupted, the target can be left partially updated and a stale Chromium `SingletonLock`; close the browser, restore from your backup, or remove the stale lock after confirming no browser is running.
- Import launches the browser **headless**, intercepts all page network requests to return inert local HTML, disables service workers for the temporary page, and validates the loaded origin. This avoids visiting live websites but does not formally guarantee that the browser itself makes no background connections. Standard Chrome sandboxing remains enabled.
- Existing Chromium/Brave profiles keep their normal OS password-store settings: Puppeteer's forced `--password-store=basic` default is dropped for non-empty profiles so imported cookies stay readable after a normal launch. Fresh disposable profiles keep the automation default.

## Usage on Linux

1. Open `about:profiles` in Firefox to find your intended profile's **Root Directory**. Close Firefox, then run:

   ```bash
   python3 tools/firefox_localstorage.py \
     --profile "$HOME/.mozilla/firefox/your-profile" \
     --output "$HOME/firefox-storage.portage.json"
   ```

   An encryption passphrase will be requested. For non-interactive usage, pipe a secret securely through `--passphrase-stdin` (never put it in shell command arguments). No upload/network request is performed.

2. Install the *optional* importer dependency, once:

   ```bash
   cd tools && npm ci && cd ..
   ```

3. Close Brave. Check data counts in **dry-run** mode (the default):

   ```bash
   node tools/chromium_localstorage_import.cjs \
     --bundle "$HOME/firefox-storage.portage.json" \
     --browser /usr/bin/brave-browser \
     --user-data-dir "$HOME/.config/BraveSoftware/Brave-Browser"
   ```

   Only the counts are printed; there are no browser changes. To actually import, repeat with `--apply` appended. Provide `--profile-directory 'Profile 1'` if your target is not `Default`. Replace `/usr/bin/brave-browser` with the executable on your system.

4. Launch Brave normally and inspect the sites you care about. **Delete the encrypted migration file when no longer needed.** Restore from your backup if necessary.

## Tests (all synthetic profiles; no personal browser data)

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/test_storage_browser.cjs
node tests/test_profile_safety.cjs
node tests/test_indexeddb_codec.cjs
node tests/test_indexeddb_paths.cjs
# Optional desktop E2E (synthetic disposable profiles only). Set
# PORTAGE_TEST_FIREFOX / PORTAGE_TEST_CHROMIUM / PORTAGE_TEST_BRAVE when the
# browsers are not at the default paths; a missing browser skips that test.
node tests/e2e_offline_import.cjs
node tests/e2e_cookie_cli.cjs
node tests/e2e_chrome.cjs
node tests/e2e_cross_browser.cjs
node tests/e2e_indexeddb.cjs
```

Chromium E2E tests verify that **requests to the synthetic target origin equal zero during import**, and the stored values remain readable after browser restart. The cross-browser test verifies Firefox LSNG decoding, AES encryption compatibility and Chromium restoration. Neither test guarantees the preservation of real-world login sessions.

## IndexedDB migration (experimental, Firefox → Chrome/Brave)

Unlike localStorage, IndexedDB stores browser-specific Structured Clone values
and may keep binary data in separate `.files` directories. **Do not copy its
SQLite files directly to Chromium.** This optional bridge launches a temporary
**copy** of your closed Firefox profile in Firefox 159+ using WebDriver BiDi,
reads each first-party origin's IndexedDB through Firefox's real IndexedDB API,
then restores databases through Chromium's native IndexedDB API. The cloned
profile still contains cookies, passwords and history even though the bridge
does not read them, so treat `/tmp/portage-idb-*` as sensitive.

During migration both browsers receive only **inert, locally intercepted HTML**
for each site. In the automated tests the source sites received zero HTTP
requests during transfer. This is *not* a guarantee of zero browser background
network activity. The transfer stays in memory; it does **not** export tokens
into an unencrypted intermediate JSON file. A temporary Firefox profile copy
containing sensitive data is created under a mode-0700 temporary directory and
removed when the tool exits normally or is interrupted with Ctrl-C / SIGTERM.
A hard kill or power failure can still leave it behind, so inspect
`portage-idb-*` in your temporary directory if a run is interrupted.

**Close both browsers and back up both profiles before beginning.** Firefox's
source is not modified: the profile is copied with reflinks, stale Firefox lock
markers are dropped, and a profile containing other symlinks is refused (copy
it to a regular directory first). Source/destination paths that contain each
other are also refused. Chromium's destination profile **will be changed**
with `--apply`. Existing IndexedDB databases are **never overwritten**: the
whole database is skipped if its name already exists at that origin. Schema and
records are written in the same version-change transaction. An interrupted
restore can still leave an **empty version-1 database container** (no object
stores); the next run detects that when the source database has stores, removes
the empty container, and retries instead of skipping it forever. Databases that
already contain object stores are preserved. A clean rerun reports intentional
existing-database skips but exits successfully.
The destination Chromium lock file and the Firefox source profile's open lock
are checked before migration; the Chromium profile named `Default` is used
unless `--chromium-profile-directory` is passed. Do not use this on a profile
that another browser process is accessing.

```bash
# First, preview first-party IndexedDB origin count, WITHOUT modifying a profile:
node tools/indexeddb_migrate.cjs \
  --firefox-profile "$HOME/.mozilla/firefox/your-profile" \
  --chromium-profile "$HOME/.config/BraveSoftware/Brave-Browser" \
  --firefox /usr/local/bin/firefox \
  --chromium /usr/bin/brave-browser

# After backing up both profiles, repeat with --apply:
node tools/indexeddb_migrate.cjs \
  --firefox-profile "$HOME/.mozilla/firefox/your-profile" \
  --chromium-profile "$HOME/.config/BraveSoftware/Brave-Browser" \
  --firefox /usr/local/bin/firefox \
  --chromium /usr/bin/brave-browser --apply
```

This companion uses the same `tools/node_modules/puppeteer-core` dependency as
the other CLI; run `npm ci --prefix tools` first. Firefox must support WebDriver
BiDi; validated with Firefox 159.0b5, Google Chrome 156.0.8078.47, and
**Brave Stable 1.98.60** in disposable test profiles. Origin enumeration reads the QuotaManager `storage.sqlite`
metadata; only HTTP(S) origins without Firefox container/partition attributes
are considered. It does not read passwords or cookies; the temporary clone
copies the whole Firefox profile, so treat it as sensitive.

**Migrated**: IndexedDB database names and versions, object stores, key paths,
auto-increment flags, indexes (including multi-entry/unique), primary keys, and
supported stored values: ordinary objects/arrays (class-instance prototypes are
dropped, as in structured clone), strings/numbers/booleans,
BigInt, Date, RegExp, Map/Set, binary buffers, typed arrays (including
`Float16Array` where the browsers support it; multi-byte elements carry a byte
order marker so cross-endian migrations do not byte-swap values), Blob/File,
`Error` subclasses (name/message/stack/cause), `Number`/`String`/`Boolean`
wrapper objects, `AggregateError` (including `.errors`), and `ImageData`
(including `colorSpace`).

**Still unsupported**: cyclic or shared object references, CryptoKey, other
platform/browser objects, databases larger than 32 MiB in the encoded wire
representation, an origin whose encoded payload exceeds 64 MiB, stores with
over 50,000 records, arrays with over 50,000 elements, individual
Blob/File/ArrayBuffer/typed-array/ImageData values larger than 8 MiB (checked
before they are expanded), and a per-origin snapshot/restore that takes longer
than 120 seconds (a timed-out run aborts and the next run retries a left-over
empty database container). The bridge **skips entire databases** when it finds
unsupported data, and reports aggregate counts without printing record values.
The IndexedDB API does not expose an object store's current auto-increment
counter, so after restoring records that were deleted at the source a new
record can reuse a deleted key number; verify apps that require monotonically
increasing keys after a migration.
There is no guarantee that every session will remain logged in; site-specific
security mechanisms and passkeys can require reauthentication. Importing an IDB
database into another browser also does not make Firefox extension storage or
browser-specific JavaScript APIs compatible.

For an actual two-origin cross-browser IndexedDB test with disposable profiles:

```bash
node tests/test_indexeddb_codec.cjs
node tests/e2e_indexeddb.cjs
```

## Offline cookie migration (experimental)

The `chromium_cookie_import.cjs` companion can transfer Firefox cookies into a
closed Chromium/Brave profile without creating a plaintext cookie bundle on
disk. Close Firefox first; the source profile's open lock is checked. Python
reads the backed-up Firefox `cookies.sqlite` and passes the records through a
**local subprocess pipe** to Chrome's native cookie API. Only aggregate counts
are printed. The entire profile should be backed up.

```bash
node tools/chromium_cookie_import.cjs \
  "$HOME/.mozilla/firefox/dev-edition-default" \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  /usr/bin/brave-browser
  # optional 4th argument: the Chromium profile directory (default: Default)
```

Firefox stores cookie expiry in milliseconds; the bridge converts it to the
seconds expected by Chromium's cookie API and never resurrects expired cookies.
Firefox containers, origin-attribute partitions, expired cookies and session
cookies are conservatively excluded, rather than incorrectly combining
isolated sessions or counting ephemeral cookies as migrated. Session cookies
are skipped because the importer closes its temporary Chromium session
immediately, so they could not survive the import anyway.
Some cookies or logins remain tied to browser/device-bound secrets; a successful
CDP `Network.setCookie` result does **not** guarantee continued authentication.
Never collect or paste exported cookie values into bug reports. If interrupted,
the target profile can be partially written and a stale `SingletonLock` left
behind; restore the backup or remove the stale lock after confirming the
browser is closed.

`node tests/e2e_cookie_cli.cjs` verifies this transfer with synthetic cookie
values and disposable Brave/Chrome profiles only; set `PORTAGE_TEST_BRAVE` if
the browser is not at `/usr/bin/brave-browser`.
