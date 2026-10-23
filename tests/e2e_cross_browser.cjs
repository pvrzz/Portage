#!/usr/bin/env node
// Firefox 159 -> AES encrypted Portage file -> offline Chrome 156 import.
// Creates only disposable profiles and uses synthetic site values.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
let pp; try { pp = require('../tools/node_modules/puppeteer-core'); } catch { pp = require('puppeteer'); }
const {decryptWrapper,validateBundle,restoreSites}=require('../tools/chromium_localstorage_import.cjs');
function fire(args) {return new Promise((resolve,reject)=>{
  let stderr='';const p=spawn('/usr/local/bin/firefox',args,{stdio:['ignore','ignore','pipe']});
  p.stderr.on('data',b=>{stderr+=b.toString()});
  const kill=setTimeout(()=>{p.kill();reject(new Error('Firefox timeout'))},20000);
  p.on('error',e=>{clearTimeout(kill);reject(e)});
  p.on('exit',code=>{clearTimeout(kill);if(code!==0)reject(new Error(`Firefox exited ${code}: ${stderr.slice(-500)}`));else resolve()});
});}
async function main(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portage-cross-browser-'));
  const fx=path.join(dir,'firefox-profile'), chrome=path.join(dir,'chrome-profile');
  fs.mkdirSync(fx);let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end('<!doctype html><meta charset="utf-8"><title>test</title><script>localStorage.setItem("migration_probe","hello-猫");localStorage.setItem("large_probe","Z".repeat(6000));</script><body>LocalStorage smoke test</body>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{
    await fire(['-no-remote','--headless','--profile',fx,'--screenshot',path.join(dir,'ff.png'),origin]);
    assert(requests>=1);
    const file=path.join(dir,'encrypted.portage.json');
    const passphrase='random-synthetic-passphrase-for-test-123';
    const exported=spawnSync('python3',['tools/firefox_localstorage.py','--profile',fx,'--output',file,'--passphrase-stdin'],{input:passphrase+'\n',encoding:'utf8'});
    assert.equal(exported.status,0,exported.stderr);
    const wrapper=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(wrapper.portage.format,'portage-bundle-encrypted');
    assert.equal(JSON.stringify(wrapper).includes('hello-猫'),false,'No plaintext stored in encrypted bundle');
    const b=await decryptWrapper(wrapper,passphrase);
    const {sites,totalKeys}=validateBundle(b);
    assert.equal(sites.length,1);assert.equal(totalKeys,2);
    assert.equal(sites[0].items.migration_probe,'hello-猫');
    assert.equal(sites[0].items.large_probe.length,6000);
    const before=requests;
    // Exercise the actual command-line importer, including encrypted input.
    const imported=spawnSync(process.execPath,[
      'tools/chromium_localstorage_import.cjs',
      '--bundle',file,'--user-data-dir',chrome,'--browser','/usr/bin/google-chrome',
      '--passphrase-stdin','--apply'
    ],{input:passphrase+'\n',encoding:'utf8',env:process.env,timeout:30000});
    assert.equal(imported.status,0,imported.stderr+'\n'+imported.stdout);
    assert(imported.stdout.includes('Imported 1/1 origins'), imported.stdout);
    assert.equal(requests,before,'Offline import must not access website');
    browser=await pp.launch({executablePath:'/usr/bin/google-chrome',headless:true,userDataDir:chrome,args:['--disable-background-networking','--no-first-run']});
    const page=await browser.newPage();
    await page.goto(origin);
    const v=await page.evaluate(()=>({first:localStorage.getItem('migration_probe'),len:localStorage.getItem('large_probe').length}));
    assert.deepEqual(v,{first:'hello-猫',len:6000});
    console.log('PASS Firefox 159 -> encrypted AES-256-GCM Portage bundle -> offline Chrome 156 -> persisted LocalStorage');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
