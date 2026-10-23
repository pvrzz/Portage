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
    console.log(`PASS actual Chrome ${await browser.version()}: synthetic cookie imported`);
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('E2E failed:',e.stack);process.exitCode=1});
