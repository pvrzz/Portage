#!/usr/bin/env node
// Real Chromium/Brave WebExtensions smoke test, using only temporary browser
// profiles and a local HTTP fixture; no personal browser profiles or secrets.
'use strict';
const CHROMIUM = process.env.PORTAGE_TEST_CHROMIUM || '/usr/bin/google-chrome';
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
let puppeteer; try { puppeteer = require('../tools/node_modules/puppeteer-core'); } catch { puppeteer = require('puppeteer'); }

function serve(redirectTo = null) {
  const server = http.createServer((req, res) => {
    if (redirectTo) {res.writeHead(302,{Location:redirectTo}); return res.end();}
    if (req.url === '/redirect') {
      res.writeHead(302, {Location:'http://localhost:'+server.address().port+'/'});
      return res.end();
    }
    res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
    res.end('<!DOCTYPE html><title>LocalStorage test</title><body>fixture</body>');
  });
  return new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server)));
}
async function main() {
  const server = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-e2e-'));
  const extDir = path.resolve('chrome');
  let browser;
  try {
    browser = await puppeteer.launch({executablePath: CHROMIUM,headless:true,userDataDir:dir,timeout:25000,pipe:true,enableExtensions:true,args:['--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check']});
    const id=await browser.installExtension(extDir);
    console.log('installed id:',id);
    if (!id) throw new Error('Portage extension failed to load');
    const ext=await browser.newPage();
    await ext.goto(`chrome-extension://${id}/dashboard.html`,{waitUntil:'load'});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(origin);
    const cookie = await ext.evaluate(async (domain)=>importCookies([
      {name:'portage-test',value:'synthetic',domain,hostOnly:true,path:'/',secure:false,sameSite:'unspecified'}
    ],()=>{}), '127.0.0.1');
    assert.equal(cookie.imported,1,JSON.stringify(cookie));
    assert.equal((await page.cookies()).find(c=>c.name==='portage-test')?.value,'synthetic');
    // The dashboard must also *collect* partitioned (CHIPS) cookies; Chrome's
    // getAllCookieStores()/getAll() omit them unless partitionKey is requested.
    const collected = await ext.evaluate(async () => {
      await chrome.cookies.set({url:'https://example.com/',name:'portage-partitioned',value:'p',
        secure:true,sameSite:'no_restriction',partitionKey:{topLevelSite:'https://example.com'}});
      const result = await collectCookies();
      const partitioned = result.data.find((entry) => entry.name === 'portage-partitioned');
      return {count: result.count, partitionKey: partitioned?.partitionKey || null};
    });
    assert.equal(collected.partitionKey?.topLevelSite, 'https://example.com',
      'collectCookies() must include partitioned cookies');
    assert(collected.count >= 2);
    // Importing a partitioned cookie must preserve the top-level site and the
    // third-party ancestor bit; dropping either moves it between partitions.
    const importedPartition = await ext.evaluate(async () => {
      const result = await importCookies([{
        name:'portage-import-partitioned', value:'v', domain:'example.com', path:'/', hostOnly:true,
        secure:true, sameSite:'no_restriction',
        partitionKey:{topLevelSite:'https://example.com', hasCrossSiteAncestor:true},
      }], () => {});
      const cookies = await chrome.cookies.getAll({partitionKey:{}});
      const found = cookies.find((entry) => entry.name === 'portage-import-partitioned');
      return {result, partitionKey: found?.partitionKey || null};
    });
    assert.equal(importedPartition.result.imported, 1);
    assert.equal(importedPartition.partitionKey?.topLevelSite, 'https://example.com');
    assert.equal(importedPartition.partitionKey?.hasCrossSiteAncestor, true);
    console.log(`PASS actual Chrome ${await browser.version()}: cookie import/collect, partitioning and ancestor bit`);
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('E2E failed:',e.stack);process.exitCode=1});
