# Whole-profile LocalStorage migration (experimental, Linux)

The browser extension cannot enumerate another browser's complete site storage via
WebExtension APIs. Portage's companion script therefore reads **all compatible
first-party Firefox LSNG localStorage databases**, not only open tabs. It is
read-only and standard-library-only (no Internet requests).

**Privacy:** localStorage often includes authentication tokens. Output is
**UNENCRYPTED** JSON and created with mode `0600`. Do not share, attach to bug
reports, or commit it. After migration, securely manage/delete the file per
local policy. Keep an offline backup of your Firefox profile.

1. In Firefox `about:profiles`, find the **Root Directory** of the intended
   profile. Close Firefox to avoid racing database changes.
2. Export in a private directory:

   ```sh
   python3 tools/firefox_localstorage.py \
       --profile '/path/from/about:profiles' \
       --output "$HOME/portage-localstorage.portage.json"
   ```

3. Install the **unpacked** `chrome/` Portage extension in Brave (Developer mode)
   or `firefox/` in Firefox. Open Portage, switch to Import, and load the new
   `.portage.json` file. Select LocalStorage and choose **Import selected**.
4. The extension visits *every exported origin*, sequentially, in temporary
   background tabs and writes the saved localStorage, then closes the tabs.
   This causes real network requests to those sites. It may trigger background
   actions; do not perform this on a production profile without a backup.
   The importer reports imported/skipped **origins**, not individual keys.

## Scope and limitations

- First-party HTTP(S) localStorage from `storage/default/*/ls/data.sqlite`.
- Handles UTF-8 and UTF-16BE, plus Firefox raw Snappy compression.
- Skips partitioned/container origin attributes rather than merging them into
  a different privacy context. Logs skipped/corrupt databases without contents.
- Does **not** migrate IndexedDB, sessionStorage, WebAuthn credentials, cookies,
  service workers, or origin-bound browser keys. Portage's regular browser UI
  handles cookies as a separate category.
- Does not guarantee uninterrupted login state. Some sites need fresh login.
- No login credentials are read from `logins.json`.
- Chromium must be able to load a site for its storage to be written via a
  content script. Redirects, dead origins, missing permissions and browser
  restrictions may cause individual origins to be skipped.

For tests (synthetic, no personal browser data):

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/test_storage_browser.cjs
```
