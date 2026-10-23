'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {validOrigin, validateBundle}=require('../tools/chromium_localstorage_import.cjs');
for (const browser of ['chrome','firefox']) {
  const src=fs.readFileSync(`${browser}/dashboard.js`,'utf8');
  const start=src.indexOf('function mapSameSite(');
  const end=src.indexOf('async function importTabs(',start);
  assert(start>0 && end>start);
  const ctx=vm.createContext({URL,Number,Array,IS_FIREFOX:browser==='firefox',tick:async()=>{}});
  vm.runInContext(src.slice(start,end),ctx);
  for(const s of ['strict','lax','no_restriction','unspecified']) {
    assert.equal(ctx.mapSameSite(s),s);
  }
  assert.equal(ctx.mapSameSite('unknown'),'unspecified');
  (async()=>{
    const written=[];
    ctx.api={cookies:{getAllCookieStores:async()=>[{id:browser==='firefox'?'firefox-default':'0'}],set:async d=>{written.push(d);return d;}}};
    const r=await ctx.importCookies([
      {name:'test',value:'value',domain:'example.com',path:'/',hostOnly:true,sameSite:'unspecified'},
      {name:'partition',value:'v',domain:'example.com',path:'/',hostOnly:true,sameSite:'lax',partitionKey:{topLevelSite:'https://site.test'}},
      {name:'container',domain:'example.org',storeId:'firefox-container-1',hostOnly:true},
    ],()=>{});
    assert.equal(r.imported,2);assert.equal(r.skipped,1);
    assert.equal(written[0].sameSite,'unspecified');
    assert.equal(written[1].partitionKey.topLevelSite,'https://site.test');
    if(browser==='firefox')assert.equal(written[0].firstPartyDomain,'');
    console.log(browser+': cookie import metadata and SameSite passed');
  })().catch(e=>{console.error(e);process.exitCode=1});
}
assert(validOrigin('https://example.org'));
assert(!validOrigin('javascript:foo'));
assert.throws(()=>validateBundle({portage:{format:'portage-bundle',version:1},data:{localStorage:[{origin:'https://example.org/path',items:{x:'y'}}]}}));
assert.throws(()=>validateBundle({portage:{format:'portage-bundle',version:1},data:{localStorage:[{origin:'https://example.org',items:{x:123}}]}}));
