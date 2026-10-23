#!/usr/bin/env node
/** Offline IndexedDB bridge: Firefox 159+ -> Chromium 156+, all supported origins.
 * Does not parse Firefox's opaque structured-clone SQLite blobs. A cloned
 * Firefox profile reads the data with native IDB, and Chromium reconstructs
 * the database via native IDB, using inert intercepted documents for origins.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const {encode,decode} = require('./indexeddb_codec.js');
const {validOrigin} = require('./chromium_localstorage_import.cjs');

function options(argv) {
  const o={apply:false,timeout:20000};
  for (let i=0;i<argv.length;i++) {
    const a=argv[i];
    if(a==='--apply')o.apply=true;
    else if(a==='--help')o.help=true;
    else if(['--firefox-profile','--chromium-profile','--firefox','--chromium'].includes(a)) {
      o[{'--firefox-profile':'firefoxProfile','--chromium-profile':'chromiumProfile','--firefox':'firefox','--chromium':'chromium'}[a]]=argv[++i];
    }else throw Error('Unknown option: '+a);
  }
  if(!o.help && (!o.firefoxProfile||!o.chromiumProfile||!o.firefox||!o.chromium))throw Error('Required: --firefox-profile --chromium-profile --firefox --chromium');
  return o;
}

function originsForFirefox(profile) {
  const script=path.join(__dirname,'list_firefox_idb_origins.py');
  const proc=cp.spawnSync('python3',[script,profile],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  if(proc.status!==0)throw Error('Firefox origin inventory failed: '+(proc.stderr||'no output').slice(0,300));
  const origins=JSON.parse(proc.stdout);
  if(!Array.isArray(origins)||origins.length>100000||!origins.every(validOrigin))throw Error('Invalid IndexedDB origin inventory');
  return origins;
}

async function inertPage(browser, kind) {
  const page=await browser.newPage();
  if(kind==='chromium') {await page.setBypassServiceWorker(true);await page.setCacheEnabled(false);}
  await page.setRequestInterception(true);
  page.on('request',request => {
    if(request.isNavigationRequest() && request.frame()===page.mainFrame()) {
      request.respond({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body:'<!doctype html><title>Portage offline storage transfer</title>'}).catch(()=>{});
    }else request.respond({status:204,body:''}).catch(()=>{});
  });
  return page;
}
async function navigateOffline(page,origin,timeout) {
  await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout});
  if(new URL(page.url()).origin!==origin)throw Error('Navigation crossed origin');
}

async function snapshotOrigin(page) {
  return page.evaluate(async (source) => {
    const encode=(0,eval)('('+source+')'); // trusted, embedded function source; never user input
    const output={databases:[],errors:[]};
    const metas=await indexedDB.databases();
    for(const meta of metas) {
      if(typeof meta.name!=='string')continue;
      let db;
      try {
        db=await new Promise((resolve,reject)=>{
          const r=indexedDB.open(meta.name);
          r.onsuccess=()=>resolve(r.result);
          r.onerror=()=>reject(r.error);
          r.onblocked=()=>reject(Error('IndexedDB open blocked'));
        });
        const dump={name:db.name,version:db.version,stores:[]};
        for (const storeName of Array.from(db.objectStoreNames)) {
          const tx=db.transaction(storeName,'readonly');
          const store=tx.objectStore(storeName);
          const schema={name:storeName,keyPath:store.keyPath,autoIncrement:store.autoIncrement,
            indexes:Array.from(store.indexNames,n=>{
              const ix=store.index(n);return {name:ix.name,keyPath:ix.keyPath,unique:ix.unique,multiEntry:ix.multiEntry};
            }),records:[]};
          const values=await new Promise((resolve,reject)=>{
            const req=store.getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });
          // Key retrieval is a second transaction to avoid inactive transactions after await.
          const tx2=db.transaction(storeName,'readonly');
          const keys=await new Promise((resolve,reject)=>{
            const req=tx2.objectStore(storeName).getAllKeys();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });
          if(keys.length!==values.length)throw Error('Key/value length mismatch');
          if(values.length>50000)throw Error('Store has over 50000 records (migration safety limit)');
          for(let j=0;j<values.length;j++)schema.records.push([await encode(keys[j]),await encode(values[j])]);
          dump.stores.push(schema);
        }
        if(JSON.stringify(dump).length>32*1024*1024)throw Error('Database over 32 MiB transport limit');
        if(JSON.stringify(output).length+JSON.stringify(dump).length>64*1024*1024)throw Error('Origin over 64 MiB transport limit');
        output.databases.push(dump);
      }catch(e){output.errors.push('Database '+output.databases.length+' skipped: '+String(e.message||e).slice(0,160));}
      finally {db?.close();}
    }
    return output;
  },encode.toString());
}

async function restoreOrigin(page,source) {
  return page.evaluate(async ({source,codec})=>{
    const decode=(0,eval)('('+codec+')');
    const results={restored:0,skipped:0,errors:[]};
    const existing=new Set((await indexedDB.databases()).map(x=>x.name));
    for(const spec of source.databases) {
      if(existing.has(spec.name)) {results.skipped++;results.errors.push('Existing destination database preserved');continue;}
      let db;
      try {
        // Decode EVERYTHING before creating the DB; unsupported values must not
        // leave a partially initialized destination schema.
        const decoded=spec.stores.map(s=>({name:s.name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,indexes:s.indexes,
          records:s.records.map(([k,v])=>[decode(k),decode(v)])}));
        db=await new Promise((resolve,reject)=>{
          const request=indexedDB.open(spec.name,spec.version);
          request.onupgradeneeded=()=>{
            try{
              const d=request.result;
              for(const s of decoded){
                const opts={autoIncrement:s.autoIncrement};
                if(s.keyPath!==null)opts.keyPath=s.keyPath;
                const store=d.createObjectStore(s.name,opts);
                for(const ix of s.indexes)store.createIndex(ix.name,ix.keyPath,{unique:ix.unique,multiEntry:ix.multiEntry});
              }
            }catch(e){request.transaction.abort();}
          };
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(request.error||Error('Open error'));
          request.onblocked=()=>reject(Error('IndexedDB upgrade blocked'));
        });
        for(const s of decoded){
          if(!s.records.length)continue;
          await new Promise((resolve,reject)=>{
            const tx=db.transaction(s.name,'readwrite');
            tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||Error('Write failed'));
            tx.onabort=()=>reject(tx.error||Error('Transaction aborted'));
            const store=tx.objectStore(s.name);
            try{for(const [key,value] of s.records) {
              if(s.keyPath===null)store.put(value,key);else store.put(value);
            }}catch(e){tx.abort();reject(e);}
          });
        }
        results.restored++;
      }catch(e){
        results.skipped++;
        results.errors.push(String(e.message||e).slice(0,160));
        // Newly created DB may now contain a partial subset of stores; remove it.
        if(db){db.close();db=null;}
        try{await new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(spec.name);q.onsuccess=()=>resolve();q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('DB deletion blocked'));});}catch{}
      }finally {db?.close();}
    }
    return results;
  },{source,codec:decode.toString()});
}

async function migrate(opts) {
  const fx=path.resolve(opts.firefoxProfile),target=path.resolve(opts.chromiumProfile);
  if(!fs.statSync(fx).isDirectory())throw Error('Firefox source profile is not a directory');
  if(target===fx || fx==='/' || target==='/' || target===os.homedir())throw Error('Unsafe profile directory');
  const origins=originsForFirefox(fx);
  console.log(`Firefox IndexedDB inventory: ${origins.length} first-party origin(s); container/partitioned origins intentionally excluded.`);
  if(!opts.apply){console.log('DRY RUN: No browser started. Add --apply to migrate to a backed-up target profile.');return {origins:origins.length};}
  if(fs.existsSync(path.join(target,'SingletonLock')))throw Error('Target Chromium profile appears to be open');
  for(const exe of [opts.firefox,opts.chromium])if(!fs.existsSync(exe))throw Error('Executable not found: '+exe);
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'portage-idb-'));
  fs.chmodSync(scratch,0o700);
  const clone=path.join(scratch,'firefox-clone');
  // Reflinks avoid copying large databases when the filesystem supports CoW.
  // Do NOT launch Firefox against the original profile, which would modify it.
  let fb,cb;const stats={origins:origins.length,restored:0,skipped:0,sourceSkipped:0,errors:[]};
  try {
    cp.execFileSync('cp',['-a','--reflink=auto',fx,clone],{timeout:120000});
    const pp=require('puppeteer-core');
    fb=await pp.launch({browser:'firefox',protocol:'webDriverBiDi',executablePath:opts.firefox,
      userDataDir:clone,headless:true,timeout:20000});
    cb=await pp.launch({browser:'chrome',executablePath:opts.chromium,
      userDataDir:target,headless:true,timeout:20000,
      args:['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-extensions']});
    const sourcePage=await inertPage(fb,'firefox'),destPage=await inertPage(cb,'chromium');
    for(const [i,origin]of origins.entries()){
      try {
        await navigateOffline(sourcePage,origin,opts.timeout);
        const exported=await snapshotOrigin(sourcePage);
        if(exported.errors.length){stats.sourceSkipped+=exported.errors.length;stats.errors.push({originIndex:i+1,reason:'Unsupported source database/record type'});}
        if(!exported.databases.length)continue;
        await navigateOffline(destPage,origin,opts.timeout);
        const result=await restoreOrigin(destPage,exported);
        stats.restored+=result.restored;stats.skipped+=result.skipped;
        if(result.errors.length)stats.errors.push({originIndex:i+1,reason:'Target database skipped or unsupported'});
      }catch(e){stats.skipped++;stats.errors.push({originIndex:i+1,reason:String(e.message||e).slice(0,150)});}
    }
    await sourcePage.close();await destPage.close();
  }finally {
    if(fb)await fb.close();if(cb)await cb.close();
    fs.rmSync(scratch,{recursive:true,force:true});
  }
  console.log(`IndexedDB migration: ${stats.restored} database(s) restored; ${stats.skipped} target skips; ${stats.sourceSkipped} source skips.`);
  if(stats.errors.length)console.log('Failures (origin indices only, no contents):',JSON.stringify(stats.errors));
  if(stats.skipped||stats.sourceSkipped)process.exitCode=2;
  return stats;
}
if(require.main===module){
  try{const o=options(process.argv.slice(2));
    if(o.help)console.log('Usage: node tools/indexeddb_migrate.cjs --firefox-profile PATH --chromium-profile PATH --firefox /usr/local/bin/firefox --chromium /usr/bin/google-chrome [--apply]\nDry-run by default. Use closed profiles; back up both before --apply. Existing target IndexedDB databases will be skipped.');
    else migrate(o).catch(e=>{console.error('IndexedDB transfer failed:',e.message);process.exitCode=1});
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={options,originsForFirefox,inertPage,navigateOffline,snapshotOrigin,restoreOrigin,migrate};
