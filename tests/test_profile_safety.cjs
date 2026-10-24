'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {transfer} = require('../tools/chromium_cookie_import.cjs');
const {assertSafeTargetProfile, assertDisjointProfiles, cloneFirefoxProfile, chromiumLaunchProfileOptions, chromiumLockPath, assertChromiumClosed, firefoxLockPath, isLockHeld, assertFirefoxClosed} =
  require('../tools/profile_safety.cjs');

function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for lock state'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function main() {
  assert.throws(() => assertSafeTargetProfile('/'), /root or home/);
  assert.throws(() => assertSafeTargetProfile(os.homedir()), /root or home/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-safety-'));
  const firefoxProfile = path.join(root, 'firefox-profile');
  const chromiumProfile = path.join(root, 'chromium-profile');
  fs.mkdirSync(firefoxProfile);
  fs.mkdirSync(chromiumProfile);
  fs.writeFileSync(path.join(firefoxProfile, 'prefs.js'), '');
  try {
    assert.throws(() => assertSafeTargetProfile(firefoxProfile), /looks like a Firefox profile/);
    assert.equal(assertSafeTargetProfile(chromiumProfile), chromiumProfile);
    assert.equal(assertSafeTargetProfile(path.join(root, 'not-created-yet')),
      path.join(root, 'not-created-yet'));

    // A symlink to home or root must not bypass the target guard.
    const homeLink = path.join(root, 'home-link');
    fs.symlinkSync(os.homedir(), homeLink);
    assert.throws(() => assertSafeTargetProfile(homeLink), /root or home/);
    const rootLink = path.join(root, 'root-link');
    fs.symlinkSync('/', rootLink);
    assert.throws(() => assertSafeTargetProfile(rootLink), /root or home/);

    // Profiles that contain each other are unsafe even when each path is
    // individually acceptable.
    assert.throws(() => assertDisjointProfiles(firefoxProfile, path.join(firefoxProfile, 'Default')),
      /inside the Firefox source/);
    assert.throws(() => assertDisjointProfiles(path.join(root, 'parent', 'child'), path.join(root, 'parent')),
      /inside Chromium user-data-dir/);
    assertDisjointProfiles(firefoxProfile, chromiumProfile);
    await assert.rejects(() => transfer({
      sourceProfile: firefoxProfile,
      targetProfile: path.join(firefoxProfile, 'Default'),
      browserPath: process.execPath,
    }), /inside the Firefox source/);

    // A dangling legacy `lock` symlink is a stale marker and is dropped from
    // the clone, but a data symlink makes the copy unsafe and is refused so
    // Firefox can never write through it into the source or another directory.
    fs.symlinkSync('somehost:4242', path.join(firefoxProfile, 'lock'));
    const clone = path.join(root, 'firefox-clone');
    cloneFirefoxProfile(firefoxProfile, clone);
    assert.equal(fs.existsSync(path.join(clone, 'lock')), false);
    fs.unlinkSync(path.join(firefoxProfile, 'lock'));

    const outside = path.join(root, 'outside-storage');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'token.txt'), 'synthetic');
    fs.symlinkSync(outside, path.join(firefoxProfile, 'storage'));
    assert.throws(() => cloneFirefoxProfile(firefoxProfile, path.join(root, 'unsafe-clone')),
      /contains symlinks/);
    assert.equal(fs.readFileSync(path.join(outside, 'token.txt'), 'utf8'), 'synthetic');
    fs.unlinkSync(path.join(firefoxProfile, 'storage'));
    // Fresh disposable profiles keep Puppeteer's --password-store=basic, while
    // existing profiles must not be switched to the fallback cookie key store.
    assert.deepEqual(chromiumLaunchProfileOptions(chromiumProfile), {});
    fs.mkdirSync(path.join(chromiumProfile, 'Default'));
    assert.deepEqual(chromiumLaunchProfileOptions(chromiumProfile).ignoreDefaultArgs,
      ['--password-store=basic', '--use-mock-keychain']);

    // Chrome's lock is a dangling symlink while the browser is running;
    // existsSync() would miss it, so the helper must use lstat().
    assert.equal(chromiumLockPath(chromiumProfile), null);
    assertChromiumClosed(chromiumProfile);
    fs.symlinkSync('somehost-4242', path.join(chromiumProfile, 'SingletonLock'));
    assert.equal(chromiumLockPath(chromiumProfile), path.join(chromiumProfile, 'SingletonLock'));
    assert.throws(() => assertChromiumClosed(chromiumProfile), /SingletonLock present/);
    fs.unlinkSync(path.join(chromiumProfile, 'SingletonLock'));

    // Stale lock file: exists but is not held open => the profile is closed.
    const lock = firefoxLockPath(firefoxProfile);
    // prefs.js is a marker, not a lock; add one.
    fs.writeFileSync(path.join(firefoxProfile, '.parentlock'), '');
    assert.equal(firefoxLockPath(firefoxProfile), path.join(firefoxProfile, '.parentlock'));
    assert.equal(isLockHeld(path.join(firefoxProfile, '.parentlock')), false);
    assertFirefoxClosed(firefoxProfile);

    // A live process holding the lock file open must be detected.
    const child = cp.spawn(process.execPath, ['-e',
      "require('node:fs').openSync(process.argv[1], 'r'); setTimeout(() => {}, 15000);",
      path.join(firefoxProfile, '.parentlock')], {stdio: 'ignore'});
    try {
      await waitFor(() => isLockHeld(path.join(firefoxProfile, '.parentlock')));
      assert.throws(() => assertFirefoxClosed(firefoxProfile), /appears to be in use/);
    } finally {
      child.kill('SIGKILL');
    }
    await waitFor(() => !isLockHeld(path.join(firefoxProfile, '.parentlock')));
    assertFirefoxClosed(firefoxProfile);

    // Legacy `lock` symlinks encode the PID; a live PID means the profile is
    // in use even though realpath() cannot resolve the symlink target.
    fs.unlinkSync(path.join(firefoxProfile, '.parentlock'));
    const legacyLock = path.join(firefoxProfile, 'lock');
    fs.symlinkSync(`somehost:${process.pid}`, legacyLock);
    assert.equal(isLockHeld(legacyLock), true);
    fs.unlinkSync(legacyLock);
    console.log('PASS: profile target and Firefox lock safety checks');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
