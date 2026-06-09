<div align="center">

# ⇅ Portage

**A universal browser data swap.** Export your browsing data to one portable JSON bundle, then import it into *any* browser — Chrome → Firefox, Firefox → Chrome, or the **same browser** on a new machine or profile.

Two extensions, one job. Monochrome, professional UI with animated cards, live progress bars and honest reporting. Everything runs locally — nothing is ever uploaded.

[github.com/pvrzz/Portage](https://github.com/pvrzz/Portage/)

</div>

---

## Why

Browsers make it hard to take your data with you. Portage is a tiny, transparent tool that scans everything a browser extension is *allowed* to read, packs it into a human-readable `*.portage.json` file you control, and recreates it on the other side. Because the bundle is just JSON, it doesn't care which browser made it — it's a universal swap:

- **Chrome → Firefox** and **Firefox → Chrome**
- **Chrome → Chrome** / **Firefox → Firefox** (new computer, new profile, reinstall, backup & restore)

## What transfers

Extensions can only use the WebExtension APIs — they can't read profile files off disk. Everything below round-trips through those APIs. Nothing is collected that can't be acted on.

| Data | Export | Import |
|---|---|---|
| **Bookmarks** | ✅ full tree | ✅ recreated in a `Portage Import` folder |
| **History** | ✅ url / title / time / visits | ✅ re-added (Firefox keeps titles + times; Chrome's API takes URL only) |
| **Cookies** | ✅ all (needs host permission) | ✅ re-set so logins carry over |
| **Open tabs** | ✅ | ✅ reopened |
| **Recently closed** | ✅ | ✅ reopened as tabs |
| **Reading list** | ✅ (Chrome only — Firefox has no API) | ✅ Chrome → reading list · Firefox → bookmark folder |
| **Extensions** | ✅ list → **`.txt` checklist** | ℹ️ can't auto-install — see below |

### Extensions → a reinstall checklist (`.txt`)
**No browser exposes an API to install another extension** (`management.install` does not exist), so Portage can't reinstall them for you. Instead, exporting writes a second file — `portage-<browser>-extensions-<date>.txt` — listing every extension with its description and **add-on store search links for both Firefox and Chrome**. Paste it into an AI assistant ("find these as Firefox add-ons") or click through the links. The import screen shows the same list with clickable links and a re-download button.

### Not included
Passwords and autofill have no extension API at all, so Portage leaves them out entirely. Export them from your browser's built-in settings (Chrome: Password Manager → Export; Firefox: Passwords → Import from a file).

## Privacy

- Portage holds your data **only in the page's memory**, and **wipes it the moment you export, copy, or finish importing**. It never writes to extension storage and makes no network requests.
- The bundle is **plain-text JSON and includes your cookies** (session tokens). Treat it like a password file: keep it local and delete it once imported.
- Importing the same bundle twice is not deduplicated — it creates another `Portage Import` folder and re-adds history/cookies. Import once and verify.

## Install (unpacked / temporary)

### Chrome
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `chrome/` folder.
3. Click the Portage toolbar icon → **Open Portage**.

### Firefox
1. `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick any file in `firefox/` (e.g. `manifest.json`).
   - Temporary add-ons are removed on restart — reload each session, or sign/package for a permanent install.
3. Click the Portage toolbar icon → **Open Portage**.

## Usage

1. **Source browser:** open Portage → **Export** → **Scan** → toggle off anything you don't want → **Export bundle** (saves the `.json` and, if selected, the extensions `.txt`). The data is wiped from memory right after.
2. **Target browser:** open Portage → **Import** → drop in the `.portage.json` → review → **Import selected**. Live per-category progress and an imported/skipped tally are shown.

## Layout

```
portage/
├─ chrome/                 # MV3 extension for Chrome
├─ firefox/                # MV3 (gecko) extension for Firefox
│  ├─ manifest.json        # only the manifest + icons differ between the two
│  ├─ popup.{html,js}      # toolbar launcher + quick counts
│  ├─ dashboard.{html,js}  # unified Export + Import engine (auto-detects browser)
│  ├─ background.js
│  └─ styles.css           # shared monochrome design system
└─ LICENSE                 # MIT
```

Everything except `manifest.json` and `icons/` is byte-identical in both folders — edit in `chrome/` and copy across. Bundle format: `{ portage:{ format:"portage-bundle", version:1, source, exportedAt, … }, meta:{ counts }, data:{ <category>: … } }`.

## License

[MIT](LICENSE) © pvrz

---

<div align="center">

developed by <a href="https://pvrz.lol/">pvrz</a> ♥

</div>
