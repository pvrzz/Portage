# Security Policy

Portage handles sensitive browser data, including sign-in cookies, so security reports are taken seriously. Thank you for helping keep Portage and its users safe.

## Supported Versions

Security fixes are released for the latest version only. Store installs (Chrome Web Store and Firefox Add-ons) update automatically.

| Version | Supported          |
| ------- | ------------------ |
| 2.1.x   | :white_check_mark: |
| < 2.1   | :x:                |

## Scope

In scope:

- The Portage extension for Chrome and Firefox (`chrome/` and `firefox/`)
- The `.portage.json` bundle format, including its encryption (AES-256-GCM with PBKDF2)
- The optional command-line tools in `tools/`
- The website at https://portage.pvrz.lol

Examples of what we want to hear about:

- Bundle data or passphrases leaking, being written to disk or extension storage, or being sent over the network
- Weaknesses in how bundles are encrypted or decrypted
- A crafted bundle that can run code, inject HTML, or write data the user didn't choose to import
- Cookies or other data being imported somewhere they shouldn't go (for example, the wrong container or profile)
- Problems in `tools/` that could damage or expose a browser profile

Out of scope:

- Issues that need an attacker to already control your computer or browser profile
- Someone who has your exported bundle and your passphrase being able to read it (that's how it's meant to work)
- Bugs in Chrome, Firefox or other browsers themselves (please report those to the browser vendor)
- Missing security headers or similar findings on the website with no demonstrated impact

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for security problems.

Report privately using either:

- **Email:** vulns@pvrz.lol
- **Telegram:** [@itspvrz](https://t.me/itspvrz)

Please include:

- What the problem is and what an attacker could do with it
- Steps to reproduce, or a proof of concept
- The Portage version and browser (with version) you tested on
- Whether the issue is in the extension, `tools/`, or the website

Never send real cookies, passwords or personal bundles. Use test data or a throwaway browser profile.

## What to Expect

- **Acknowledgement:** within 3 days of your report.
- **Updates:** at least once a week while we investigate.
- **If accepted:** we'll work on a fix, release it through the Chrome Web Store and Firefox Add-ons, and let you know when it's live. With your permission, we'll credit you in the release notes.
- **If declined:** we'll explain why, for example if it's out of scope or not reproducible.

Please give us a reasonable amount of time to release a fix before sharing details publicly. We're happy to agree on a disclosure date with you.

## Safe Harbor

We won't take legal action against anyone who reports issues in good faith, avoids accessing or changing other people's data, and gives us a chance to fix the problem before disclosing it.
