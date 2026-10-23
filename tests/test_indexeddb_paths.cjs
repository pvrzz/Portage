'use strict';
// Path/symlink handling for the IndexedDB tool. Runs in dry-run mode only, so
// no Firefox or Chromium executable is needed and no browser profile is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {migrate, options} = require('../tools/indexeddb_migrate.cjs');

function createQuotaDatabase(profile) {
  // Use the Python toolchain when node:sqlite is unavailable.
  const script = `import sqlite3,sys\ncon=sqlite3.connect(sys.argv[1])\ncon.execute('CREATE TABLE origin (origin TEXT, client_usages TEXT)')\ncon.execute('INSERT INTO origin VALUES (?,?)', ('https://example.test','I1234'))\ncon.commit()\ncon.close()`;
  const result = require('node:child_process').spawnSync('python3', ['-c', script, path.join(profile, 'storage.sqlite')], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-idb-paths-'));
  try {
    const source = path.join(root, 'firefox-profile');
    const target = path.join(root, 'chromium-profile');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    createQuotaDatabase(source);

    // A symlinked --firefox-profile must be resolved before cp/browser launch;
    // otherwise `cp -a` copies the symlink and Firefox opens the source profile.
    const sourceLink = path.join(root, 'firefox-link');
    fs.symlinkSync(source, sourceLink);
    const dry = await migrate({
      firefoxProfile: sourceLink, chromiumProfile: target,
      firefox: path.join(root, 'missing-firefox'), chromium: path.join(root, 'missing-chromium'),
      apply: false,
    });
    assert.equal(dry.origins, 1);

    // A target that is a symlink to the source must be rejected, not silently
    // used as the destination profile.
    const targetLink = path.join(root, 'chromium-link');
    fs.symlinkSync(source, targetLink);
    await assert.rejects(() => migrate({
      firefoxProfile: sourceLink, chromiumProfile: targetLink,
      firefox: path.join(root, 'missing-firefox'), chromium: path.join(root, 'missing-chromium'),
      apply: false,
    }), /must differ|looks like a Firefox profile/);

    // A Firefox-looking Chromium target is refused before anything is written.
    fs.writeFileSync(path.join(target, 'prefs.js'), '');
    await assert.rejects(() => migrate({
      firefoxProfile: source, chromiumProfile: target,
      firefox: path.join(root, 'missing-firefox'), chromium: path.join(root, 'missing-chromium'),
      apply: false,
    }), /looks like a Firefox profile/);

    const parsed = options([
      '--firefox-profile', source, '--chromium-profile', target,
      '--firefox', '/usr/bin/firefox', '--chromium', '/usr/bin/chromium',
      '--chromium-profile-directory', 'Profile 1',
    ]);
    assert.equal(parsed.chromiumProfileDirectory, 'Profile 1');
    assert.throws(() => options([
      '--firefox-profile', source, '--chromium-profile', target,
      '--firefox', '/usr/bin/firefox', '--chromium', '/usr/bin/chromium',
      '--chromium-profile-directory', '../escape',
    ]), /Invalid Chromium profile directory/);
    console.log('PASS: IndexedDB path resolution, symlink and profile guards');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
