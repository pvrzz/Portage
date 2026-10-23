#!/usr/bin/env node
// Real Chromium/Brave WebExtensions smoke test, using only temporary browser
// profiles and a local HTTP fixture; no personal browser profiles or secrets.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

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
  const server2 = await serve();
  const redirectServer = await serve(`http://127.0.0.1:${server.address().port}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-e2e-'));
  const extDir = path.resolve('chrome');
  let browser;
  try {
    browser = await puppeteer.launch({executablePath: '/usr/bin/google-chrome',headless:true,userDataDir:dir,timeout:25000,pipe:true,enableExtensions:true,args:['--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check']});
    const id=await browser.installExtension(extDir);
    console.log('installed id:',id);
    if (!id) throw new Error('Portage extension failed to load');
    const ext=await browser.newPage();
    await ext.goto(`chrome-extension://${id}/dashboard.html`,{waitUntil:'load'});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const origin2=`http://127.0.0.1:${server2.address().port}`;
    const redirectOrigin=`http://127.0.0.1:${redirectServer.address().port}`;
    const results=await ext.evaluate(async (origin, origin2, redirectOrigin)=> {
      return await importLocalStorage([
        {origin,items:{k1:'persisted',unicode:'猫'}},
        {origin:origin2,items:{second:'isolated'}},
        {origin:redirectOrigin,items:{poison:'must-not-write'}},
      ],()=>{});
    },origin,origin2,redirectOrigin);
    assert.equal(results.imported,2,JSON.stringify(results));
    assert.equal(results.skipped,1,JSON.stringify(results));
    const page=await browser.newPage();
    await page.goto(origin);
    assert.equal(await page.evaluate(()=>localStorage.getItem('k1')),'persisted');
    assert.equal(await page.evaluate(()=>localStorage.getItem('unicode')),'猫');
    assert.equal(await page.evaluate(()=>localStorage.getItem('poison')),null);
    const another = await browser.newPage();
    await another.goto(origin2);
    assert.equal(await another.evaluate(()=>localStorage.getItem('second')),'isolated');
    assert.equal(await another.evaluate(()=>localStorage.getItem('k1')),null);
    const cookie = await ext.evaluate(async (domain)=>importCookies([
      {name:'portage-test',value:'synthetic',domain,hostOnly:true,path:'/',secure:false,sameSite:'unspecified'}
    ],()=>{}), '127.0.0.1');
    assert.equal(cookie.imported,1,JSON.stringify(cookie));
    assert.equal((await page.cookies()).find(c=>c.name==='portage-test')?.value,'synthetic');
    console.log(`PASS actual Chrome ${await browser.version()}: data written and readable after navigation`);
  } finally {
    if(browser) await browser.close();
    await Promise.all([server,server2,redirectServer].map(s=>new Promise(resolve=>s.close(resolve))));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('E2E failed:',e.stack);process.exitCode=1});
