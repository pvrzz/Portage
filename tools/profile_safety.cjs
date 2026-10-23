'use strict';
// Shared safety checks for the optional profile migration CLI tools.
// These helpers refuse obviously wrong target directories and detect a
// Firefox profile that is still open before its SQLite files are read/copied.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const FIREFOX_MARKERS = ['prefs.js', 'places.sqlite', 'cookies.sqlite', 'storage.sqlite'];

// Resolve a target path as far as it exists. Existing symlinks are followed so
// that a link to `/` or the home directory cannot bypass the guard below; for a
// not-yet-created directory, the parent symlinks are resolved instead.
function resolveForSafety(directory) {
  const resolved = path.resolve(directory);
  try {
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent)) return path.join(fs.realpathSync(parent), path.basename(resolved));
  } catch { /* fall through to the lexical path */ }
  return resolved;
}

function assertSafeTargetProfile(directory, label = 'Chromium profile') {
  const resolved = resolveForSafety(directory);
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

function findSymlinks(directory, root = directory, found = []) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) found.push(path.relative(root, full));
    else if (entry.isDirectory()) findSymlinks(full, root, found);
  }
  return found;
}

// Copying a profile that contains symlinks is dangerous: `cp -a` preserves
// them, so the clone can point back at the original profile or outside the
// scratch directory. Reflink-copy first (fast), drop Firefox's stale lock
// markers, then refuse any remaining symlink so Firefox can only write inside
// the disposable clone. Users with symlinked storage can copy the profile to a
// regular directory first.
function cloneFirefoxProfile(source, destination) {
  cp.execFileSync('cp',
    ['-a', '--reflink=auto', source, destination],
    {timeout: 120000});
  for (const name of ['.parentlock', 'lock']) {
    try { fs.rmSync(path.join(destination, name), {force: true}); } catch {}
  }
  const symlinks = findSymlinks(destination);
  if (symlinks.length) {
    throw new Error(`Firefox profile contains symlinks (${symlinks.slice(0, 5).join(', ')}); ` +
      'copy the profile to a regular directory before IndexedDB migration so the source cannot be modified');
  }
}

// Two profiles must not contain each other, otherwise Chromium can write into
// the Firefox source (or vice versa) despite both paths being individually safe.
function assertDisjointProfiles(source, target, label = 'Chromium user-data-dir') {
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (inside(source, target)) {
    throw new Error(`Refusing overlapping profiles: ${label} is inside the Firefox source profile: ${target}`);
  }
  if (inside(target, source)) {
    throw new Error(`Refusing overlapping profiles: Firefox source profile is inside ${label}: ${source}`);
  }
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
  try {
    target = fs.realpathSync(lockPath);
  } catch {
    // macOS/BSD Firefox uses `lock`, a symlink such as "host:1234", rather
    // than an open file descriptor. Fall back to checking that PID.
    try {
      const match = /:([0-9]+)$/.exec(fs.readlinkSync(lockPath));
      if (match) {
        try { process.kill(Number(match[1]), 0); return true; } catch { return false; }
      }
    } catch { /* not a symlink */ }
    return false;
  }
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

module.exports = {assertSafeTargetProfile, assertDisjointProfiles, cloneFirefoxProfile, chromiumLaunchProfileOptions, chromiumLockPath, assertChromiumClosed, firefoxLockPath, isLockHeld, assertFirefoxClosed};
