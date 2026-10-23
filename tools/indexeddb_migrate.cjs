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
const {validOrigin} = require('./chromium_localstorage_import.cjs');
const {assertSafeTargetProfile, assertDisjointProfiles, cloneFirefoxProfile, assertChromiumClosed, assertFirefoxClosed, chromiumLaunchProfileOptions} = require('./profile_safety.cjs');

function options(argv) {
  const o={apply:false,timeout:20000};
  for (let i=0;i<argv.length;i++) {
    const a=argv[i];
    if(a==='--apply')o.apply=true;
    else if(a==='--help')o.help=true;
    else if(['--firefox-profile','--chromium-profile','--firefox','--chromium','--chromium-profile-directory'].includes(a)) {
      o[{'--firefox-profile':'firefoxProfile','--chromium-profile':'chromiumProfile','--firefox':'firefox','--chromium':'chromium','--chromium-profile-directory':'chromiumProfileDirectory'}[a]]=argv[++i];
    }else throw Error('Unknown option: '+a);
  }
  if(!o.help && (!o.firefoxProfile||!o.chromiumProfile||!o.firefox||!o.chromium))throw Error('Required: --firefox-profile --chromium-profile --firefox --chromium');
  if(o.chromiumProfileDirectory&&(!/^[\w. -]+$/.test(o.chromiumProfileDirectory)||o.chromiumProfileDirectory==='.'||o.chromiumProfileDirectory==='..'))throw Error('Invalid Chromium profile directory name');
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
  // Do not let a source page escape into another origin or create popups.
  page.on('popup', popup => popup.close().catch(() => {}));
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
  // Load trusted codec from the local repository, no eval or remote scripts.
  await page.addScriptTag({path:path.join(__dirname,'indexeddb_codec.js')});
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error(label+' timed out after '+Math.round(timeoutMs/1000)+'s')),timeoutMs);
    }),
  ]).finally(()=>clearTimeout(timer));
}

async function snapshotOrigin(page) {
  return page.evaluate(async () => {
    const {encode}=globalThis.PortageIDBCodec;
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
        let encodedChars=0;
        for (const storeName of Array.from(db.objectStoreNames)) {
          const tx=db.transaction(storeName,'readonly');
          const store=tx.objectStore(storeName);
          const schema={name:storeName,keyPath:store.keyPath,autoIncrement:store.autoIncrement,
            indexes:Array.from(store.indexNames,n=>{
              const ix=store.index(n);return {name:ix.name,keyPath:ix.keyPath,unique:ix.unique,multiEntry:ix.multiEntry};
            }),records:[]};
          // Cap retrieval at 50,001 entries. Individual binary values are
          // capped in the codec before they are expanded into number arrays,
          // and the encoded budget below stops oversized databases early.
          const values=await new Promise((resolve,reject)=>{
            const req=store.getAll(undefined,50001);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });
          // Key retrieval is a second transaction to avoid inactive transactions after await.
          const tx2=db.transaction(storeName,'readonly');
          const keys=await new Promise((resolve,reject)=>{
            const req=tx2.objectStore(storeName).getAllKeys(undefined,50001);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });
          if(keys.length!==values.length)throw Error('Key/value length mismatch');
          if(values.length>50000)throw Error('Store has over 50000 records (migration safety limit)');
          for(let j=0;j<values.length;j++){
            const encodedKey=await encode(keys[j]);
            const encodedValue=await encode(values[j]);
            encodedChars+=JSON.stringify([encodedKey,encodedValue]).length;
            if(encodedChars>32*1024*1024)throw Error('Database over 32 MiB encoded transport limit');
            schema.records.push([encodedKey,encodedValue]);
          }
          dump.stores.push(schema);
        }
        if(JSON.stringify(dump).length>32*1024*1024)throw Error('Database over 32 MiB transport limit');
        if(JSON.stringify(output).length+JSON.stringify(dump).length>64*1024*1024)throw Error('Origin over 64 MiB transport limit');
        output.databases.push(dump);
      }catch(e){output.errors.push('Database '+output.databases.length+' skipped: '+String(e.message||e).slice(0,160));}
      finally {db?.close();}
    }
    return output;
  });
}

async function restoreOrigin(page,source) {
  return page.evaluate(async ({source})=>{
    const {decode}=globalThis.PortageIDBCodec;
    const results={restored:0,skipped:0,errors:[]};
    const existing=new Set((await indexedDB.databases()).map(x=>x.name));
    for(const spec of source.databases) {
      if(existing.has(spec.name)) {results.skipped++;continue;}
      let db;
      let created=false;
      let failure=null;
      try {
        // Decode EVERYTHING before creating the DB; unsupported values must not
        // leave a partially initialized destination schema.
        const decoded=spec.stores.map(s=>({name:s.name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,indexes:s.indexes,
          records:s.records.map(([k,v])=>[decode(k),decode(v)])}));
        db=await new Promise((resolve,reject)=>{
          const request=indexedDB.open(spec.name,spec.version);
          request.onupgradeneeded=()=>{
            created=true;
            try{
              const d=request.result;
              for(const s of decoded){
                const opts={autoIncrement:s.autoIncrement};
                if(s.keyPath!==null)opts.keyPath=s.keyPath;
                const store=d.createObjectStore(s.name,opts);
                for(const ix of s.indexes)store.createIndex(ix.name,ix.keyPath,{unique:ix.unique,multiEntry:ix.multiEntry});
                // Write schema and records in the same versionchange
                // transaction so an interrupted restore cannot leave a
                // schema-only database that later runs skip forever.
                for(const [key,value] of s.records){
                  if(s.keyPath===null)store.put(value,key);else store.put(value);
                }
              }
            }catch(e){
              failure=e;
              try{request.transaction.abort();}catch{}
            }
          };
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(failure||request.error||Error('Open error'));
          request.onblocked=()=>reject(Error('IndexedDB upgrade blocked'));
        });
        results.restored++;
      }catch(e){
        results.skipped++;
        results.errors.push(String(e.message||e).slice(0,160));
        // Only remove a database created by THIS migration attempt. Never
        // delete a target database when validation failed before creation.
        if(db){db.close();db=null;}
        if(created){
          try{await new Promise((resolve,reject)=>{
            const q=indexedDB.deleteDatabase(spec.name);
            q.onsuccess=()=>resolve();q.onerror=()=>reject(q.error);
            q.onblocked=()=>reject(Error('DB deletion blocked'));
          });}catch{results.errors.push('Partial database cleanup failed; inspect target profile');}
        }
      }finally {db?.close();}
    }
    return results;
  },{source});
}

const cleanupState = {paths: [], browsers: []};
function cleanupSensitiveState() {
  for (const browser of cleanupState.browsers) {
    try { browser.process?.()?.kill?.('SIGKILL'); } catch {}
  }
  for (const target of cleanupState.paths) {
    try { fs.rmSync(target, {recursive: true, force: true}); } catch {}
  }
  cleanupState.paths.length = 0;
  cleanupState.browsers.length = 0;
}
function installCleanupHandlers() {
  // Ctrl-C or SIGTERM must not leave the temporary Firefox profile clone (which
  // contains cookies and storage data) behind in /tmp.
  const handler = (signal) => { cleanupSensitiveState(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => { process.removeListener('SIGINT', handler); process.removeListener('SIGTERM', handler); };
}

function realDirectory(directory, label) {
  if(!fs.existsSync(directory))throw Error(`${label} does not exist: ${directory}`);
  const resolved=fs.realpathSync(directory);
  if(!fs.statSync(resolved).isDirectory())throw Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

async function migrate(opts) {
  // Resolve symlinks: cp -a would otherwise copy a symlink of the source
  // profile and Firefox would be launched against the original profile.
  const fx=realDirectory(opts.firefoxProfile, 'Firefox source profile');
  const target=assertSafeTargetProfile(opts.chromiumProfile, 'Chromium user-data-dir');
  if(target===fx)throw Error('Source and destination profiles must differ');
  assertDisjointProfiles(fx, target);
  assertFirefoxClosed(fx);
  const origins=originsForFirefox(fx);
  console.log(`Firefox IndexedDB inventory: ${origins.length} first-party origin(s); container/partitioned origins intentionally excluded.`);
  if(!opts.apply){console.log('DRY RUN: No browser started. Add --apply to migrate to a backed-up target profile.');return {origins:origins.length};}
  assertChromiumClosed(target);
  for(const exe of [opts.firefox,opts.chromium])if(!fs.existsSync(exe))throw Error('Executable not found: '+exe);
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'portage-idb-'));
  fs.chmodSync(scratch,0o700);
  cleanupState.paths.push(scratch);
  const removeSignalHandlers = installCleanupHandlers();
  const clone=path.join(scratch,'firefox-clone');
  // Reflinks avoid copying large databases when the filesystem supports CoW.
  // Do NOT launch Firefox against the original profile, which would modify it.
  let fb,cb;const stats={origins:origins.length,restored:0,skipped:0,sourceSkipped:0,errors:[]};
  try {
    cloneFirefoxProfile(fx,clone);
    const pp=require('puppeteer-core');
    fb=await pp.launch({browser:'firefox',protocol:'webDriverBiDi',executablePath:opts.firefox,
      userDataDir:clone,headless:true,timeout:20000,
      extraPrefsFirefox:{
        'browser.startup.page':0,
        'browser.startup.homepage':'about:blank',
        'browser.sessionstore.resume_from_crash':false,
        'dom.serviceWorkers.enabled':false,
        'extensions.enabledScopes':0,
      }});
    cleanupState.browsers.push(fb);
    cb=await pp.launch({browser:'chrome',executablePath:opts.chromium,
      userDataDir:target,headless:true,timeout:20000,...chromiumLaunchProfileOptions(target),
      args:['--profile-directory='+(opts.chromiumProfileDirectory||'Default'),'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-extensions']});
    cleanupState.browsers.push(cb);
    const sourcePage=await inertPage(fb,'firefox'),destPage=await inertPage(cb,'chromium');
    for(const [i,origin]of origins.entries()){
      try {
        await navigateOffline(sourcePage,origin,opts.timeout);
        const exported=await withTimeout(snapshotOrigin(sourcePage),120000,'IndexedDB snapshot');
        if(exported.errors.length){stats.sourceSkipped+=exported.errors.length;stats.errors.push({originIndex:i+1,reason:'Unsupported source database/record type'});}
        if(!exported.databases.length)continue;
        await navigateOffline(destPage,origin,opts.timeout);
        const result=await withTimeout(restoreOrigin(destPage,exported),120000,'IndexedDB restore');
        stats.restored+=result.restored;stats.skipped+=result.skipped;
        if(result.errors.length)stats.errors.push({originIndex:i+1,reason:'Target database skipped or unsupported'});
      }catch(e){stats.skipped++;stats.errors.push({originIndex:i+1,reason:String(e.message||e).slice(0,150)});if(String(e.message||'').includes('timed out'))throw e;}
    }
    await sourcePage.close();await destPage.close();
  }finally {
    // Finally must always attempt to dispose of the sensitive source clone,
    // even if either browser fails to shut down cleanly.
    try {if(fb)await fb.close();} catch(e) {console.warn('Firefox close failed:',e.message);}
    try {if(cb)await cb.close();} catch(e) {console.warn('Chromium close failed:',e.message);}
    cleanupState.browsers = cleanupState.browsers.filter(browser => browser !== fb && browser !== cb);
    fs.rmSync(scratch,{recursive:true,force:true});
    cleanupState.paths = cleanupState.paths.filter(entry => entry !== scratch);
    removeSignalHandlers();
  }
  console.log(`IndexedDB migration: ${stats.restored} database(s) restored; ${stats.skipped} target skips; ${stats.sourceSkipped} source skips.`);
  if(stats.errors.length)console.log('Failures (origin indices only, no contents):',JSON.stringify(stats.errors));
  // Existing destination databases are intentionally skipped, so only real
  // source/restore errors make the command exit non-zero.
  if(stats.sourceSkipped||stats.errors.length)process.exitCode=2;
  return stats;
}
if(require.main===module){
  try{const o=options(process.argv.slice(2));
    if(o.help)console.log('Usage: node tools/indexeddb_migrate.cjs --firefox-profile PATH --chromium-profile PATH --firefox /usr/local/bin/firefox --chromium /usr/bin/google-chrome [--apply]\nDry-run by default. Use closed profiles; back up both before --apply. Existing target IndexedDB databases will be skipped. [--chromium-profile-directory Default]');
    else migrate(o).catch(e=>{console.error('IndexedDB transfer failed:',e.message);process.exitCode=1});
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={options,originsForFirefox,inertPage,navigateOffline,snapshotOrigin,restoreOrigin,migrate};
