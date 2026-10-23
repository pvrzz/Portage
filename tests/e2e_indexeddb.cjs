'use strict';
const CHROMIUM = process.env.PORTAGE_TEST_CHROMIUM || '/usr/bin/google-chrome';
const FIREFOX = process.env.PORTAGE_TEST_FIREFOX || '/usr/local/bin/firefox';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
let pp; try { pp = require('../tools/node_modules/puppeteer-core'); } catch { pp = require('puppeteer'); }
const {migrate,originsForFirefox,inertPage,navigateOffline,restoreOrigin}=require('../tools/indexeddb_migrate.cjs');
async function main(){
  if(!fs.existsSync(FIREFOX)||!fs.existsSync(CHROMIUM)){console.log(`SKIP: Firefox/Chromium not found (PORTAGE_TEST_FIREFOX=${FIREFOX}, PORTAGE_TEST_CHROMIUM=${CHROMIUM})`);return;}
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'portage-idb-test-'));
  const fx=path.join(scratch,'firefox'),chrome=path.join(scratch,'chrome');
  const hits=[0,0];
  const servers=[0,1].map(i=>http.createServer((req,res)=>{hits[i]++;res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end('<!doctype html><title>fixture</title>');}));
  await Promise.all(servers.map(s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve))));
  const origins=servers.map(s=>`http://127.0.0.1:${s.address().port}`);
  let browser;
  try {
    browser=await pp.launch({browser:'firefox',protocol:'webDriverBiDi',executablePath:FIREFOX,userDataDir:fx,headless:true});
    const page=await browser.newPage();
    for(const [n,origin] of origins.entries()) {
      await page.goto(origin);
      await page.evaluate(async number=>{
        const r=indexedDB.open('portage-indexeddb-test',7);
        await new Promise((resolve,reject)=>{
          r.onupgradeneeded=()=>{
            const db=r.result;
            db.createObjectStore('keyed',{keyPath:'id'}).createIndex('by-name','name',{unique:true});
            db.createObjectStore('auto',{autoIncrement:true}).createIndex('by-tag','tag',{multiEntry:true});
          };
          r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);
        });
        const db=r.result;
        await new Promise((resolve,reject)=>{
          const tx=db.transaction(['keyed','auto'],'readwrite');
          const obj={id:number+1,name:'site-'+number,when:new Date('2020-02-03T04:05:06Z'),
            bytes:new Uint8Array([1,2,3,255]),big:12345678901234567890n,
            blob:new Blob(['file-contents'],{type:'text/plain'}),
            map:new Map([['hello','猫']]),set:new Set(['a','b']),
            maybe:undefined,negativeZero:-0};
          tx.objectStore('keyed').put(obj);
          tx.objectStore('auto').put({tag:['alpha','beta'],value:'origin-'+number});
          tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
        });
        db.close();
      },n);
    }
    await browser.close();browser=null;
    assert.deepEqual(originsForFirefox(fx),[...origins].sort());
    const before=hits.slice();
    const stats=await migrate({firefoxProfile:fx,chromiumProfile:chrome,firefox:FIREFOX,chromium:CHROMIUM,apply:true,timeout:20000});
    assert.equal(stats.restored,2,JSON.stringify(stats));
    assert.deepEqual(hits,before,'IndexedDB migration must not access real origin');
    browser=await pp.launch({executablePath:CHROMIUM,userDataDir:chrome,headless:true,args:['--disable-background-networking']});
    const verify=await inertPage(browser,'chromium');
    for(const [n,origin] of origins.entries()){
      await navigateOffline(verify,origin,20000);
      const result=await verify.evaluate(async()=>{
        const names=await indexedDB.databases();
        const r=indexedDB.open('portage-indexeddb-test');
        const db=await new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
        const t=db.transaction(['keyed','auto'],'readonly');
        const s=t.objectStore('keyed');const a=t.objectStore('auto');
        const obj=await new Promise((ok,no)=>{let q=s.getAll();q.onsuccess=()=>ok(q.result[0]);q.onerror=()=>no(q.error)});
        const au=await new Promise((ok,no)=>{let q=a.getAll();q.onsuccess=()=>ok(q.result[0]);q.onerror=()=>no(q.error)});
        const byName=await new Promise((ok,no)=>{let q=s.index('by-name').get(obj.name);q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)});
        const byTag=await new Promise((ok,no)=>{let q=a.index('by-tag').get('alpha');q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)});
        const results={version:db.version,storeCount:db.objectStoreNames.length,
          name:obj.name,id:obj.id,when:obj.when.toISOString(),bytes:Array.from(obj.bytes),
          big:String(obj.big),blob:await obj.blob.text(),map:obj.map.get('hello'),set:Array.from(obj.set),
          undefinedValue:obj.maybe===undefined,negativeZero:Object.is(obj.negativeZero,-0),
          byName:byName.name,byTag:byTag.value,autoValue:au.value};
        db.close();return results;
      });
      assert.deepEqual(result,{version:7,storeCount:2,name:'site-'+n,id:n+1,
        when:'2020-02-03T04:05:06.000Z',bytes:[1,2,3,255],
        big:'12345678901234567890',blob:'file-contents',map:'猫',set:['a','b'],
        undefinedValue:true,negativeZero:true,byName:'site-'+n,byTag:'origin-'+n,autoValue:'origin-'+n});
      // Invalid structured clone payload must not create a partially valid DB.
      const rejected=await restoreOrigin(verify,{databases:[{
        name:'portage-unsupported-test',version:1,stores:[{
          name:'bad',keyPath:null,autoIncrement:false,indexes:[],
          records:[[{t:'number',v:1},{t:'unsupported-cryptokey'}]]
        }]
      }]});
      assert.equal(rejected.restored,0);
      assert.equal(rejected.skipped,1);
      const after=await verify.evaluate(()=>indexedDB.databases());
      assert(!after.some(x=>x.name==='portage-unsupported-test'), 'Rejected DB should not exist');
    }
    await verify.close();await browser.close();browser=null;
    assert.deepEqual(hits,before,'No real site traffic including verification');
    // Re-running must never overwrite existing destination IndexedDB databases.
    const repeated=await migrate({firefoxProfile:fx,chromiumProfile:chrome,firefox:FIREFOX,chromium:CHROMIUM,apply:true,timeout:20000});
    assert.equal(repeated.restored,0);assert.equal(repeated.skipped,2);
    process.exitCode=undefined;
    console.log('PASS: Firefox 159 -> Chrome 156 indexedDB: 2 origins, schema, indexes, rich values, no target-site traffic');
  }finally{
    if(browser)await browser.close();
    await Promise.all(servers.map(s=>new Promise(ok=>s.close(ok))));
    fs.rmSync(scratch,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
