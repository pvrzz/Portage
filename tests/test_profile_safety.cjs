'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {assertSafeTargetProfile, chromiumLaunchProfileOptions, chromiumLockPath, assertChromiumClosed, firefoxLockPath, isLockHeld, assertFirefoxClosed} =
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
    console.log('PASS: profile target and Firefox lock safety checks');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
