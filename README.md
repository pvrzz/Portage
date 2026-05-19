# Portage

**Browser Transitioning Tool** by [pvrz](https://github.com/pvrzz)

Bulk-migrate chrome extensions and cookies between chromium browsers. Opens chrome web store pages in labeled tab groups for extensions, and provides encrypted JSON export/import for cookies.

```
github: https://github.com/pvrzz/portage
```

## install (load unpacked)

1. unzip somewhere stable (chrome points at the folder, not a copy)
2. open `chrome://extensions`
3. enable developer mode (top right)
4. click "load unpacked" and select the folder
5. pin Portage from the puzzle icon

## features

**two-pane interface** — top tabs switch between extensions and cookies. each has installed/imported sub-tabs.

**extensions** — select the ones you want, "open in tab group" opens all their chrome web store install pages in a labeled cyan tab group. drag the group title to detach into its own window. cross-machine works via an HTML export that's also a standalone clickable page.

**cookies** — grouped by domain, expand to inspect individual cookies (with secure/httpOnly/session flags). export as JSON with optional AES-GCM encryption (passphrase-protected via PBKDF2). import reads the same format and applies cookies back to the browser, preserving security flags.

## encryption details

- PBKDF2 with SHA-256, 250,000 iterations
- AES-GCM 256-bit
- 128-bit random salt, 96-bit random IV per export
- format declares algorithm and parameters for forward compatibility
- runs entirely in your browser via Web Crypto API, no library deps

## permissions

| permission | reason |
|---|---|
| `management` | list installed extensions |
| `tabs` + `tabGroups` | create the install tab group |
| `downloads` | save export files |
| `cookies` | read and write cookies for migration |
| `<all_urls>` | required for cookies api to access all domains |

no network access, no remote scripts, no analytics. ~1030 lines across 5 files, all local.

## file structure

```
portage/
├── manifest.json       mv3 manifest
├── popup.html          ui structure
├── popup.css           styles
├── popup.js            logic + crypto
└── icons/              16/48/128 png
```

## known limits

- popup closes when it loses focus during operations — don't click outside mid-encryption
- cookies file is essentially session tokens. always encrypt for transfer, never send or email; especially when it's unencrypted
- some sites use device fingerprinting or token rebinding that defeats cookie migration. re-login on important services (banking, financial, work portals)
- sideloaded/dev-mode extensions show a "sideload" badge — they won't have web store pages

## license

MIT-style: do whatever, attribute if you fork.
