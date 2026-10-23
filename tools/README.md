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
   cd tools && npm install && cd ..
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
