#!/usr/bin/env node
'use strict';
/** Private-process Firefox -> Chromium cookie transfer. Do not print cookie values. */
const cp=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const {assertSafeTargetProfile, assertChromiumClosed, assertFirefoxClosed, chromiumLaunchProfileOptions}=require('./profile_safety.cjs');
function assertProfileDirectory(value) {
  if(typeof value!=='string'||!/^[\w. -]+$/.test(value)||value==='.'||value==='..')throw Error('Invalid Chromium profile directory name');
  return value;
}
async function transfer({sourceProfile,targetProfile,browserPath,profileDirectory='Default'}) {
  const source=path.resolve(sourceProfile);
  const target=assertSafeTargetProfile(targetProfile, 'Chromium user-data-dir');
  if(!fs.existsSync(source)||!fs.existsSync(browserPath))throw Error('Source or browser missing');
  if(source===target)throw Error('Source and destination profiles must differ');
  assertProfileDirectory(profileDirectory);
  assertFirefoxClosed(source);
  assertChromiumClosed(target);
  const p=cp.spawnSync('python3',[path.join(__dirname,'firefox_cookie_stream.py'),source],{
    encoding:'utf8',maxBuffer:32*1024*1024,timeout:20000,stdio:['ignore','pipe','pipe']});
  if(p.status!==0)throw Error('Cookie decoding failed; no destination modifications');
  const parsed=JSON.parse(p.stdout);p.stdout='';
  let puppeteer=require('puppeteer-core'),browser;
  const result={candidate:parsed.cookies.length,skipped:parsed.skipped,accepted:0,failed:0};
  try{
    browser=await puppeteer.launch({executablePath:browserPath,userDataDir:target,headless:true,
      ...chromiumLaunchProfileOptions(target),
      args:['--profile-directory='+profileDirectory,'--disable-background-networking','--disable-sync','--disable-extensions','--no-first-run']});
    const page=await browser.newPage(),session=await page.createCDPSession();
    for(const cookie of parsed.cookies){
      try{
        let {success}=await session.send('Network.setCookie',cookie);
        if(success)result.accepted++;else result.failed++;
      }catch(e){result.failed++;}
    }
  }finally{if(browser)await browser.close();}
  return result;
}
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.length!==3&&args.length!==4){console.error('Usage: node chromium_cookie_import.cjs FIREFOX_CLOSED_PROFILE CHROMIUM_CLOSED_PROFILE CHROME_EXECUTABLE [CHROMIUM_PROFILE_DIRECTORY]');process.exit(2)}
  transfer({sourceProfile:args[0],targetProfile:args[1],browserPath:args[2],profileDirectory:args[3]||'Default'}).then(r=>{
    console.log('Cookies (counts only):',JSON.stringify(r));if(r.failed)process.exitCode=2;
  }).catch(e=>{console.error('Cookie import failed:',e.message);process.exitCode=1});
}
module.exports={transfer,assertProfileDirectory};
