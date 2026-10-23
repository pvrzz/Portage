'use strict';
const assert=require('node:assert/strict');
const {encode,decode}=require('../tools/indexeddb_codec.js');
(async()=>{
  const entries=[undefined,null,true,false,'hello 猫',0,-0,1.25,NaN,Infinity,-Infinity,123n,
    new Date('2021-02-03T04:05:06Z'), new Date(NaN),/abc/gi,
    new Uint8Array([0,200,255]),new Int32Array([-2,1,900]),new DataView(new Uint8Array([7,8,9]).buffer),
    new Blob(['hello'],{type:'text/plain'}),new Map([['a',12]]),new Set(['a','b']),
    [1,undefined,'x'],{a:'__proto__',nested:{b:'yes'}}];
  for(const entry of entries){
    const encoded=JSON.parse(JSON.stringify(await encode(entry)));
    const restored=decode(encoded);
    if(entry===undefined) assert.equal(restored,undefined);
    else if(typeof entry==='number')assert(Object.is(restored,entry));
    else if(typeof entry==='bigint')assert.equal(restored,entry);
    else if(entry instanceof Blob)assert.equal(await restored.text(),await entry.text());
    else if(entry instanceof Date)assert.equal(Number.isNaN(entry.valueOf())?Number.isNaN(restored.valueOf()):restored.valueOf(),Number.isNaN(entry.valueOf())?true:entry.valueOf());
    else if(entry instanceof RegExp)assert.equal(restored.toString(),entry.toString());
    else if(entry instanceof DataView)assert.deepEqual(Array.from(new Uint8Array(restored.buffer)),Array.from(new Uint8Array(entry.buffer)));
    else if(ArrayBuffer.isView(entry))assert.deepEqual(Array.from(restored),Array.from(entry));
    else if(entry instanceof Map||entry instanceof Set)assert.deepEqual([...restored],[...entry]);
    else assert.deepEqual(JSON.parse(JSON.stringify(restored)),JSON.parse(JSON.stringify(entry)));
  }
  const cycle={};cycle.self=cycle;
  await assert.rejects(()=>encode(cycle),/cyclic/);
  const special=Object.create(null);Object.defineProperty(special,'__proto__',{value:{safe:1},enumerable:true});
  const recovered=decode(JSON.parse(JSON.stringify(await encode(special))));
  assert.equal(Object.getPrototypeOf(recovered),null);
  assert.deepEqual(recovered['__proto__'].safe,1);
  const normal={alpha:1};
  const normalRestored=decode(JSON.parse(JSON.stringify(await encode(normal))));
  assert.equal(Object.getPrototypeOf(normalRestored),Object.prototype);
  const arr=[1,,3];arr.label='tag';
  const arrRestored=decode(JSON.parse(JSON.stringify(await encode(arr))));
  assert.equal(arrRestored.label,'tag');assert.equal(1 in arrRestored,false);
  console.log('PASS: IndexedDB codec rich types, -0, invalid dates, cyclic rejection and prototype safety');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
