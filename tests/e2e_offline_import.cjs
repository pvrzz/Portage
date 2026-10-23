#!/usr/bin/env node
'use strict';
const CHROMIUM = process.env.PORTAGE_TEST_CHROMIUM || '/usr/bin/google-chrome';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
let puppeteer; try { puppeteer = require('../tools/node_modules/puppeteer-core'); } catch { puppeteer = require('puppeteer'); }
const {run,validateBundle} = require('../tools/chromium_localstorage_import.cjs');

async function main() {
  let hits=0;
  const server=http.createServer((req,res)=>{hits++;res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Fixture</title>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portage-offline-e2e-'));
  const profile=path.join(dir,'profile');
  const origin=`http://127.0.0.1:${server.address().port}`;
  // A __proto__ key must survive as ordinary localStorage data, not mutate the
  // bundle object. JSON.parse (unlike an object literal) creates an own property.
  const items=JSON.parse('{"token":"synthetic-value","a":"猫","__proto__":"proto-value"}');
  const bundle={portage:{format:'portage-bundle',version:1,source:'firefox'},data:{localStorage:[{origin,items}]}};
  const file=path.join(dir,'synthetic.portage.json');
  fs.writeFileSync(file,JSON.stringify(bundle),{mode:0o600});
  try {
    assert.equal(validateBundle(bundle).totalKeys,3);
    await run({bundle:file, userDataDir:profile, browser:CHROMIUM, profileDirectory:'Default', timeout:12000, apply:true});
    assert.equal(hits,0,'Importer must NOT send a single request to the origin');
    const browser=await puppeteer.launch({executablePath:CHROMIUM,headless:true,userDataDir:profile,args:['--no-sandbox','--disable-background-networking']});
    try {
      const page=await browser.newPage();
      await page.goto(origin);
      assert.equal(await page.evaluate(()=>localStorage.getItem('token')),'synthetic-value');
      assert.equal(await page.evaluate(()=>localStorage.getItem('a')),'猫');
      assert.equal(await page.evaluate(()=>localStorage.getItem('__proto__')),'proto-value');
    } finally {await browser.close();}
    console.log('PASS Chrome offline LocalStorage restore: zero origin requests during import; persistent after restart');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error(err.stack);process.exitCode=1;});
