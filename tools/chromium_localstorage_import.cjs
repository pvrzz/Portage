#!/usr/bin/env node
/**
 * Offline, cross-origin Chromium localStorage importer.
 * Chrome/Brave is launched under a user-specified (preferably empty) profile;
 * request interception fulfills ALL page requests locally with inert HTML.
 * No extension or direct LevelDB editing is necessary.
 * Dependency: puppeteer-core (or puppeteer). Node >=20.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

function parseArgs(argv) {
  const opts = {apply: false, profileDirectory: 'Default', timeout: 12000};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--passphrase-stdin') opts.passphraseStdin = true;
    else if (['--bundle','--user-data-dir','--browser','--profile-directory','--timeout-ms'].includes(a)) {
      const v = argv[++i]; if (!v) throw Error(`Missing value for ${a}`);
      const key = {'--bundle':'bundle','--user-data-dir':'userDataDir','--browser':'browser','--profile-directory':'profileDirectory','--timeout-ms':'timeout'}[a];
      opts[key] = key === 'timeout' ? Number(v) : v;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw Error(`Unknown argument: ${a}`);
  }
  if (!opts.help && (!opts.bundle || !opts.userDataDir || !opts.browser)) throw Error('Required: --bundle FILE --user-data-dir DIR --browser PATH');
  if (!Number.isFinite(opts.timeout) || opts.timeout < 1000 || opts.timeout > 120000) throw Error('Invalid timeout');
  if (!/^[\w. -]+$/.test(opts.profileDirectory) || opts.profileDirectory === '.' || opts.profileDirectory === '..') throw Error('Invalid profile directory');
  return opts;
}

function validOrigin(origin) {
  if (typeof origin !== 'string' || origin.includes('^')) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}

function validateBundle(obj) {
  if (obj?.portage?.format !== 'portage-bundle' || obj?.portage?.version !== 1) throw Error('Invalid Portage bundle format');
  const sites = obj?.data?.localStorage;
  if (!Array.isArray(sites)) throw Error('Bundle does not contain localStorage');
  if (sites.length > 100000) throw Error('Too many origins');
  const seen = new Set();
  let totalKeys = 0;
  for (const site of sites) {
    if (!validOrigin(site?.origin)) throw Error('Unsafe or unsupported site origin in bundle');
    if (seen.has(site.origin)) throw Error('Duplicate origin in bundle');
    seen.add(site.origin);
    const values = site.items;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.getPrototypeOf(values) !== Object.prototype) throw Error('Invalid localStorage entries');
    const keys = Object.keys(values);
    totalKeys += keys.length;
    if (keys.length > 10000 || totalKeys > 1000000) throw Error('Too many storage entries');
    if (keys.some(k => typeof values[k] !== 'string')) throw Error('Non-string storage values');
  }
  return {sites, totalKeys};
}

async function passphrasePrompt() {
  if (!process.stdin.isTTY) throw Error('Encrypted bundle: use --passphrase-stdin, or run interactively');
  const rl = readline.createInterface({input: process.stdin, output: process.stderr});
  // Prevent echoing a password to the terminal.
  rl._writeToOutput = () => {};
  return new Promise(resolve => {process.stderr.write('Portage bundle passphrase: '); rl.question('', s => {process.stderr.write('\n');rl.close();resolve(s);});});
}

async function readPassphrase(stdinFlag) {
  if (!stdinFlag) return passphrasePrompt();
  const chunks=[];
  for await(const c of process.stdin) chunks.push(c);
  const value=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!value) throw Error('Empty passphrase from standard input');
  return value;
}

async function decryptWrapper(wrapper, passphrase) {
  const p = wrapper.portage;
  if (p?.format !== 'portage-bundle-encrypted' || p?.version !== 1 ||
      p.cipher !== 'AES-GCM' || p.kdf !== 'PBKDF2' || p.hash !== 'SHA-256' || p.keyLength !== 256 ||
      !Number.isInteger(p.iterations) || p.iterations < 100000 || p.iterations > 2000000) throw Error('Unsupported encryption format');
  const salt=Buffer.from(p.salt,'base64'), iv=Buffer.from(p.iv,'base64'), ct=Buffer.from(wrapper.ciphertext,'base64');
  if(salt.length !== 16 || iv.length !== 12 || ct.length < 16 || ct.length > 512*1024*1024) throw Error('Invalid encrypted bundle size');
  const key = crypto.pbkdf2Sync(passphrase,salt,p.iterations,32,'sha256');
  const dec = crypto.createDecipheriv('aes-256-gcm',key,iv);
  dec.setAuthTag(ct.subarray(ct.length-16));
  let inner;
  try {inner=JSON.parse(Buffer.concat([dec.update(ct.subarray(0,-16)),dec.final()]).toString('utf8'));}
  catch {throw Error('Cannot decrypt: wrong passphrase or corrupted bundle');}
  return {portage:{format:'portage-bundle',version:1,source:p.source},meta:inner.meta,data:inner.data};
}

async function loadBundle(filename, passphraseStdin) {
  const stat=fs.statSync(filename);
  if (stat.size > 512*1024*1024) throw Error('Bundle too large');
  const wrapper=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(wrapper?.portage?.format==='portage-bundle-encrypted') {
    const pass=await readPassphrase(passphraseStdin);
    return await decryptWrapper(wrapper,pass);
  }
  return wrapper;
}

/** For every origin, respond to *every* navigation/subresource request locally. */
async function restoreSites(browser, sites, timeout=12000) {
  const results = {imported: 0, skipped: 0, keys: 0, errors: []};
  const page=await browser.newPage();
  await page.setBypassServiceWorker(true);
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', req=>{
    const isDocument=req.isNavigationRequest() && req.frame() === page.mainFrame();
    if (isDocument) req.respond({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body:'<!doctype html><html><head><title>Portage localStorage import</title></head><body></body></html>'}).catch(()=>{});
    else req.respond({status:204,body:''}).catch(()=>{});
  });
  for(let i=0;i<sites.length;i++) {
    const site=sites[i];
    try {
      await page.goto(site.origin+'/',{waitUntil:'domcontentloaded',timeout});
      if (new URL(page.url()).origin !== site.origin) throw Error('Unexpected navigation origin');
      const pairs=Object.entries(site.items);
      const result=await page.evaluate((entries)=>{
        // Entire operation occurs in one renderer task, before site scripts (page is inert).
        const old=[];
        try {
          for(const [k,v] of entries) {
            old.push([k,localStorage.getItem(k)]);
            localStorage.setItem(k,v);
          }
          if(entries.some(([k,v])=>localStorage.getItem(k)!==v)) throw Error('Storage verification failed');
        } catch(e) {
          for(let j=old.length-1;j>=0;j--) {
            const [k,v]=old[j];
            try{if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch{}
          }
          throw e;
        }
        return entries.length;
      }, pairs);
      if(result!==pairs.length)throw Error('Storage key count mismatch');
      results.imported++;results.keys+=result;
    } catch(e) {
      results.skipped++;
      results.errors.push({index:i+1,reason:String(e.message||e).slice(0,180)});
    }
  }
  await page.close();
  return results;
}

async function run(opts) {
  const bundle=await loadBundle(path.resolve(opts.bundle),opts.passphraseStdin);
  const {sites,totalKeys}=validateBundle(bundle);
  const profile=path.resolve(opts.userDataDir);
  if(profile==='/' || profile===require('node:os').homedir()) throw Error('Refusing to use root or home as Chrome user-data-dir');
  const lock=path.join(profile,'SingletonLock');
  if (fs.existsSync(lock) || fs.lstatSync(lock, {throwIfNoEntry:false})) throw Error('Browser profile appears to be in use (SingletonLock present); close browser and retry');
  console.log(`Validated ${sites.length} origins / ${totalKeys} LocalStorage keys.`);
  const unsupportedIdb = bundle?.meta?.unsupported?.indexedDBOrigins;
  if (Number.isInteger(unsupportedIdb) && unsupportedIdb > 0) {
    console.warn(`WARNING: ${unsupportedIdb} Firefox IndexedDB origin(s) are not migrated; some logins may require reauthentication.`);
  }
  if(!opts.apply){console.log('DRY RUN: No browser started; pass --apply after creating a backup.');return;}
  if(!fs.existsSync(opts.browser))throw Error('Browser executable not found');
  let puppeteer;
  try{puppeteer=require('puppeteer-core');}catch{try{puppeteer=require('puppeteer');}catch{throw Error('Install puppeteer-core locally (npm i --no-save puppeteer-core)');}}
  // Never start with a personal profile unless explicitly specified by the operator.
  // Keep Chrome sandbox enabled; do not pass --no-sandbox.
  const browser=await puppeteer.launch({executablePath:path.resolve(opts.browser),userDataDir:profile,
    headless:true,defaultViewport:{width:600,height:400},
    args:['--profile-directory='+opts.profileDirectory,'--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--disable-sync','--disable-extensions','--disable-features=MediaRouter']});
  let result;
  try {result=await restoreSites(browser,sites,opts.timeout);}
  finally {await browser.close();}
  console.log(`Imported ${result.imported}/${sites.length} origins and ${result.keys} keys; skipped ${result.skipped}.`);
  if(result.errors.length)console.log('Skipped (index and reason; no credentials):',JSON.stringify(result.errors));
  if(result.skipped)process.exitCode=2;
}

if(require.main===module) {
  let opts;
  try{opts=parseArgs(process.argv.slice(2));
    if(opts.help){console.log('Usage: node tools/chromium_localstorage_import.cjs --bundle FILE --user-data-dir DIR --browser /path/to/chrome [--profile-directory Default] [--passphrase-stdin] [--apply]\nDry-run is default. Requires puppeteer-core to --apply. No remote site requests are made by the importer.');process.exit(0);}
    run(opts).catch(e=>{console.error('Error:',e.message);process.exitCode=1});
  }catch(e){console.error('Error:',e.message);process.exitCode=1}
}
module.exports={parseArgs,validOrigin,validateBundle,loadBundle,decryptWrapper,restoreSites,run};
