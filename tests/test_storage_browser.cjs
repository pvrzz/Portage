'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const browser of ['chrome','firefox']) {
  const src = fs.readFileSync(`${browser}/dashboard.js`, 'utf8');
  const start = src.indexOf('function mapSameSite(');
  const end = src.indexOf('async function importTabs(', start);
  assert(start > 0 && end > start);
  const ctx = vm.createContext({URL, setTimeout, clearTimeout, Object, Number, Array, tick: async () => {}, IS_FIREFOX: browser === 'firefox'});
  vm.runInContext(src.slice(start,end), ctx);
  assert.equal(vm.runInContext('mapSameSite("unspecified")', ctx), 'unspecified');
  assert.equal(vm.runInContext('mapSameSite("no_restriction")', ctx), 'no_restriction');
  assert.equal(vm.runInContext('mapSameSite("unknown")', ctx), 'unspecified');
  assert.equal(vm.runInContext('isSafeStorageOrigin("https://site.test")', ctx), true);
  assert.equal(vm.runInContext('isSafeStorageOrigin("https://site.test/evil")', ctx), false);
  (async () => {
    const visited = [], closed = [], written = [];
    const listeners = new Set();
    ctx.api = {
      tabs: {
        create: async ({url}) => { const id = visited.length+1; visited.push(url); return {id}; },
        get: async (id) => ({status:'complete', url: visited[id-1]}),
        remove: async (id) => {closed.push(id)},
        onUpdated: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f)},
      },
      scripting: { executeScript: async ({target,func,args}) => {
        const old = ctx.localStorage;
        ctx.localStorage={setItem:(k,v)=>written.push([k,v])};
        // Function is evaluated in a tab by the actual browser; here emulate it.
        const total = Object.entries(args[0]).length;
        ctx.localStorage=old;
        return [{result:total}];
      }},
      cookies: {getAllCookieStores: async()=>[{id:browser==='firefox'?'firefox-default':'0'}],set:async()=>({})},
    };
    const sites = [
      {origin:'https://first.test',items:{a:'a-value'}},
      {origin:'https://second.test',items:{b:'b-value'}},
      {origin:'javascript:alert(1)',items:{c:'nope'}},
    ];
    const result = await ctx.importLocalStorage(sites, () => {});
    assert.equal(result.imported,2);
    assert.equal(result.skipped,1);
    assert.deepEqual(visited,['https://first.test','https://second.test']);
    assert.deepEqual(closed,[1,2]);
    const cookie = await ctx.importCookies([{name:'s',value:'v',domain:'example.com',hostOnly:true,sameSite:'unspecified'}],()=>{});
    assert.equal(cookie.imported,1);
    console.log(`${browser}: storage sites, origin validation, cookies and SameSite passed`);
  })().catch((err)=>{console.error(err);process.exitCode=1;});
}
