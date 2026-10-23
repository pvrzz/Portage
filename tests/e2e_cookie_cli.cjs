'use strict';
// Synthetic Firefox cookie DB -> CDP cookie import -> disposable Brave/Chrome
// profile. No real browser profile or cookie value is read or written.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {transfer} = require('../tools/chromium_cookie_import.cjs');
let puppeteer;
try { puppeteer = require('../tools/node_modules/puppeteer-core'); } catch { puppeteer = require('puppeteer'); }

const BROWSER = process.env.PORTAGE_TEST_BRAVE
  || process.env.PORTAGE_TEST_COOKIE_BROWSER
  || '/usr/bin/brave-browser';

(async () => {
  if (!fs.existsSync(BROWSER)) {
    console.log(`SKIP: browser not found at ${BROWSER}; set PORTAGE_TEST_BRAVE`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-cookie-cli-'));
  const src = path.join(root, 'firefox'), dst = path.join(root, 'chromium');
  fs.mkdirSync(src);
  const futureMs = Date.now() + 3600 * 1000;
  const pastMs = Date.now() - 3600 * 1000;
  try {
    // moz_cookies.expiry is milliseconds since the epoch. The expired row and
    // a seconds-based value would both have been imported by the old code.
    const code = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE moz_cookies (name TEXT,value TEXT,host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)')
c.executemany('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)',[
  ('hello','test-value','example.com','/',${futureMs},1,1,1,''),
  ('expired','test-value','example.com','/',${pastMs},1,0,1,''),
  ('divided','test-value','example.org','/',${futureMs},1,1,2,'^userContextId=1'),
  ('invalid','test-value','example.org','/',${futureMs},0,0,0,''),
])
c.commit()`;
    const created = cp.spawnSync('python3', ['-c', code, path.join(src, 'cookies.sqlite')], {encoding: 'utf8'});
    assert.equal(created.status, 0, created.stderr);

    const result = await transfer({sourceProfile: src, targetProfile: dst, browserPath: BROWSER});
    assert.equal(result.candidate, 1);
    assert.equal(result.accepted, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped.partitioned_or_containers, 1);
    assert.equal(result.skipped.expired, 1, 'expired milliseconds cookies must be excluded');
    assert.equal(result.skipped.insecure_none, 1);

    const browser = await puppeteer.launch({
      executablePath: BROWSER, userDataDir: dst, headless: true, args: ['--disable-background-networking'],
    });
    try {
      const page = await browser.newPage();
      const session = await page.createCDPSession();
      const stored = (await session.send('Storage.getCookies')).cookies;
      const hello = stored.find((cookie) => cookie.name === 'hello');
      assert(hello && hello.httpOnly && hello.secure);
      assert(Math.abs(hello.expires - futureMs / 1000) < 5, 'expiry must be stored in seconds');
      assert(!stored.some((cookie) => cookie.name === 'expired'), 'expired cookie must not be resurrected');
    } finally {
      await browser.close();
    }
    console.log('PASS native Chromium cookie CLI: expiry unit/expiry filtering, unsafe/partitioned skipped');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
