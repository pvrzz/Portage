'use strict';
// Shared safety checks for the optional profile migration CLI tools.
// These helpers refuse obviously wrong target directories and detect a
// Firefox profile that is still open before its SQLite files are read/copied.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const FIREFOX_MARKERS = ['prefs.js', 'places.sqlite', 'cookies.sqlite', 'storage.sqlite'];

function assertSafeTargetProfile(directory, label = 'Chromium profile') {
  const resolved = path.resolve(directory);
  if (resolved === '/' || resolved === os.homedir()) {
    throw new Error(`Refusing to use root or home as ${label}: ${resolved}`);
  }
  for (const marker of FIREFOX_MARKERS) {
    if (fs.existsSync(path.join(resolved, marker))) {
      throw new Error(`${label} looks like a Firefox profile (${marker}); refusing to write Chromium data into ${resolved}`);
    }
  }
  return resolved;
}

const CHROMIUM_KEYRING_DEFAULT_ARGS = ['--password-store=basic', '--use-mock-keychain'];

// Puppeteer forces --password-store=basic, which encrypts cookies with the
// fallback key. That is fine for disposable profiles but can make cookies
// unreadable in an existing profile whose normal launch uses the OS keyring.
// For existing profiles, drop that default so Chromium uses its normal store.
function chromiumLaunchProfileOptions(profile) {
  const existing = fs.existsSync(path.join(profile, 'Local State'))
    || fs.existsSync(path.join(profile, 'Default'));
  return existing ? {ignoreDefaultArgs: CHROMIUM_KEYRING_DEFAULT_ARGS.slice()} : {};
}

function chromiumLockPath(profile) {
  // Chrome's SingletonLock is a dangling symlink while the browser is running.
  // existsSync() follows links and returns false for it, so use lstat().
  const candidate = path.join(profile, 'SingletonLock');
  return fs.lstatSync(candidate, {throwIfNoEntry: false}) ? candidate : null;
}

function assertChromiumClosed(profile) {
  if (chromiumLockPath(profile)) {
    throw new Error(`Chromium profile appears to be open (SingletonLock present); close the browser and retry. If no browser is running, remove the stale SingletonLock after confirming: ${profile}`);
  }
}

function firefoxLockPath(profile) {
  for (const name of ['.parentlock', 'lock']) {
    const candidate = path.join(profile, name);
    if (fs.lstatSync(candidate, {throwIfNoEntry: false})) return candidate;
  }
  return null;
}

// Returns true when some process holds the lock file open. Firefox keeps an
// open descriptor on its profile lock for as long as the profile is in use;
// existence alone is not enough because a crash can leave a stale lock behind.
function isLockHeld(lockPath) {
  let target;
  try { target = fs.realpathSync(lockPath); } catch { return false; }
  if (fs.existsSync('/proc')) {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let descriptors;
      try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const descriptor of descriptors) {
        let linked;
        try { linked = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`); } catch { continue; }
        if (linked === target || linked === target + ' (deleted)') return true;
      }
    }
    return false;
  }
  // Non-Linux fallback: fuser is part of psmisc and reports whether a file is
  // open. If neither /proc nor fuser is available, fail closed instead of
  // silently copying a profile that might still be in use.
  const probe = cp.spawnSync('fuser', ['-s', lockPath], {timeout: 3000, stdio: 'ignore'});
  if (probe.error || probe.status === null) {
    throw new Error('Cannot verify that the Firefox profile is closed (no /proc and no fuser); close Firefox and retry');
  }
  return probe.status === 0;
}

function assertFirefoxClosed(profile) {
  const lockPath = firefoxLockPath(profile);
  if (lockPath && isLockHeld(lockPath)) {
    throw new Error(`Firefox profile appears to be in use (${path.basename(lockPath)} is open); close Firefox and retry`);
  }
  return lockPath;
}

module.exports = {assertSafeTargetProfile, chromiumLaunchProfileOptions, chromiumLockPath, assertChromiumClosed, firefoxLockPath, isLockHeld, assertFirefoxClosed};
