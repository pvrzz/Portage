'use strict';
const cp=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {transfer}=require('../tools/chromium_cookie_import.cjs');
const pp=require('../tools/node_modules/puppeteer-core');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'portage-cookie-cli-'));
 const src=path.join(root,'firefox'),dst=path.join(root,'brave');fs.mkdirSync(src);
 try{
  const code=`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE moz_cookies (name TEXT,value TEXT,host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)');c.executemany('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)',[
    ('hello','test-value','example.com','/',1999999999,1,1,1,''),
    ('divided','test-value','example.org','/',1999999999,1,1,2,'^userContextId=1'),
    ('invalid','test-value','example.org','/',1999999999,0,0,0,''),
  ]);c.commit()`;
  const p=cp.spawnSync('python3',['-c',code,path.join(src,'cookies.sqlite')],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  const result=await transfer({sourceProfile:src,targetProfile:dst,browserPath:'/usr/bin/brave-browser'});
  assert.equal(result.candidate,1);assert.equal(result.accepted,1);assert.equal(result.failed,0);
  assert.equal(result.skipped.partitioned_or_containers,1);assert.equal(result.skipped.insecure_none,1);
  const browser=await pp.launch({executablePath:'/usr/bin/brave-browser',userDataDir:dst,headless:true,args:['--disable-background-networking']});
  try{const page=await browser.newPage(),session=await page.createCDPSession();let r=await session.send('Storage.getCookies');assert(r.cookies.some(c=>c.name==='hello'&&c.httpOnly&&c.secure));}
  finally{await browser.close()}
  console.log('PASS native Brave cookie CLI: 1 persisted; unsafe/partitioned skipped');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
