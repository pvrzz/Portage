# Experimental whole-profile Firefox → Chromium LocalStorage migration

The Portage extension cannot enumerate every origin's LocalStorage via WebExtension APIs. This optional Linux companion migrates **every compatible first-party Firefox LocalStorage origin** by reading the offline Firefox profile and writing via a separate, headless Chrome/Brave session. It does **not** depend on currently open tabs, and does **not** visit the real websites during import.

**This is not complete browser-profile migration.** It does *not* migrate IndexedDB, sessionStorage, Service Workers, Firefox Containers, partitioned localStorage, WebAuthn/passkeys, or device-bound session credentials. Login persistence cannot be guaranteed. Cookies and bookmarks can be migrated separately using the standard Portage extension.

## Safety / prerequisites

- Backup the Firefox and Chromium/Brave profiles first.
- Close Firefox before exporting; close Brave/Chrome before applying to its profile. The importer refuses an existing Chromium `SingletonLock`.
- LocalStorage can contain live session tokens. **Encrypted AES-256-GCM export is the default**; use a long unique passphrase. `--plaintext` is an explicitly unsafe opt-out. Output is mode 0600. Never attach exported bundles to an issue, share them, or commit them.
- Require **Python 3** and `cryptography` for encryption (`sudo apt install python3-cryptography` on Debian), and **Node.js 20+**, plus Puppeteer Core (`cd tools && npm install`). Puppeteer Core uses the existing installed Chrome/Brave and downloads no browsers.
- The exporter reports a **count of IndexedDB origins omitted** (without opening their records), so you can estimate missing coverage.
- Import is **merge/upsert**: values with matching LocalStorage keys in the target are overwritten. Use a fresh Chromium profile where possible. Failed sites are reported and attempted writes are rolled back within the page when possible; this does not provide cross-origin atomic transactions.
- Import launches the browser **headless**, intercepts all page network requests to return inert local HTML, disables service workers for the temporary page, and validates the loaded origin. This avoids visiting live websites but does not formally guarantee that the browser itself makes no background connections. Standard Chrome sandboxing remains enabled.

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
# Optional desktop E2E: local Firefox 159 and Chrome 156 were verified;
# needs installed Firefox and Google Chrome plus Puppeteer
node tests/e2e_cross_browser.cjs
node tests/e2e_offline_import.cjs
node tests/e2e_chrome.cjs
```

Chromium E2E tests verify that **requests to the synthetic target origin equal zero during import**, and the stored values remain readable after browser restart. The cross-browser test verifies Firefox LSNG decoding, AES encryption compatibility and Chromium restoration. Neither test guarantees the preservation of real-world login sessions.

## IndexedDB migration (experimental, Firefox → Chrome/Brave)

Unlike localStorage, IndexedDB stores browser-specific Structured Clone values
and may keep binary data in separate `.files` directories. **Do not copy its
SQLite files directly to Chromium.** This optional bridge launches a temporary
**copy** of your closed Firefox profile in Firefox 159+ using WebDriver BiDi,
reads each first-party origin's IndexedDB through Firefox's real IndexedDB API,
then restores databases through Chromium's native IndexedDB API.

During migration both browsers receive only **inert, locally intercepted HTML**
for each site. In the automated tests the source sites received zero HTTP
requests during transfer. This is *not* a guarantee of zero browser background
network activity. The transfer stays in memory; it does **not** export tokens
into an unencrypted intermediate JSON file. A temporary Firefox profile copy
containing sensitive data is created under a mode-0700 temporary directory and
removed when the tool exits normally. A crash or power failure can leave it
behind, so inspect `portage-idb-*` in your temporary directory if interrupted.

**Close both browsers and back up both profiles before beginning.** Firefox's
source is not modified, but Chromium's destination profile **will be changed**
with `--apply`. Existing IndexedDB databases are **never overwritten**: the
whole database is skipped if its name already exists at that origin. The destination Chromium lock file and the Firefox source profile's live lock are checked before migration. Do not use this on a profile
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
are considered. It does not inspect Chrome or Firefox passwords/cookies.

**Migrated**: IndexedDB database names and versions, object stores, key paths,
auto-increment flags, indexes (including multi-entry/unique), primary keys, and
supported stored values (ordinary objects/arrays, strings/numbers/booleans,
BigInt, Date, RegExp, Map/Set, binary buffers and typed arrays, Blob/File).

**Still unsupported**: cyclic or shared object references, CryptoKey,
non-standard browser objects, IndexedDB databases larger than 32 MiB in the
wire representation, stores with over 50,000 records, and individual Blob/File
values larger than 8 MiB. The bridge **skips entire databases** when it finds
unsupported data, and reports aggregate counts without printing record values.
There is no guarantee that every session will remain logged in; site-specific
security mechanisms and passkeys can require reauthentication. Importing an IDB
database into another browser also does not make Firefox extension storage or
browser-specific JavaScript APIs compatible.

For an actual two-origin cross-browser IndexedDB test with disposable profiles:

```bash
node tests/test_indexeddb_codec.cjs
node tests/e2e_indexeddb.cjs
```
