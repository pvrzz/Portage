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
  // Structured-cloneable built-ins that are not plain objects.
  const error=new TypeError('boom');error.cause={code:'E_TEST'};
  const errorRestored=decode(JSON.parse(JSON.stringify(await encode(error))));
  assert(errorRestored instanceof TypeError);
  assert.equal(errorRestored.message,'boom');
  assert.equal(errorRestored.name,'TypeError');
  assert.deepEqual(errorRestored.cause,{code:'E_TEST'});
  assert(decode(JSON.parse(JSON.stringify(await encode(Object(42))))) instanceof Number);
  assert.equal(decode(JSON.parse(JSON.stringify(await encode(Object('x'))))).valueOf(),'x');
  assert.equal(decode(JSON.parse(JSON.stringify(await encode(Object(false))))).valueOf(),false);
  // Site-controlled Error.name must not be used as a plain-object key.
  for(const name of ['constructor','__proto__','toString']){
    const named=new Error('named');named.name=name;
    const restored=decode(JSON.parse(JSON.stringify(await encode(named))));
    assert(restored instanceof Error,name);
    assert.equal(restored.message,'named');
  }
  if(typeof AggregateError!=='undefined'){
    const aggregate=new AggregateError([new TypeError('first'),new Error('second')],'many');
    const restored=decode(JSON.parse(JSON.stringify(await encode(aggregate))));
    assert(restored instanceof AggregateError);
    assert.equal(restored.message,'many');
    assert.deepEqual(restored.errors.map((error)=>error.message),['first','second']);
  }
  // Symbol.toStringTag spoofing must not turn a plain object into a wrapper.
  class Spoofed{constructor(){this.x=1;}get [Symbol.toStringTag](){return 'Number';}valueOf(){return 7;}}
  await assert.rejects(()=>encode(new Spoofed()),/Unsupported IndexedDB object prototype/);
  class Plainish{constructor(){this.x=1;}}
  const plainish=decode(JSON.parse(JSON.stringify(await encode(new Plainish()))));
  assert.equal(plainish.x,1);
  assert.equal(Object.getPrototypeOf(plainish),Object.prototype);

  // Typed arrays carry the source byte order; decoding the same big-endian
  // payload on a little-endian host must still produce the original values.
  const bigEndianTypedArray={t:'typedarray',type:'Uint16Array',le:false,
    v:Buffer.from([0,1,1,2]).toString('base64')};
  assert.deepEqual(Array.from(decode(bigEndianTypedArray)),[1,258]);

  if(typeof Float16Array!=='undefined'){
    const floats=new Float16Array([1.5,-2]);
    const restored=decode(JSON.parse(JSON.stringify(await encode(floats))));
    assert(restored instanceof Float16Array);
    assert.deepEqual(Array.from(restored),Array.from(floats));
  }

  const cycle={};cycle.self=cycle;
  await assert.rejects(()=>encode(cycle),/cyclic/);
  const shared={shared:true};
  await assert.rejects(()=>encode([shared,shared]),/Shared\/cyclic/);
  // Binary values are rejected before expansion; an 8 MiB value is allowed
  // and base64 keeps its encoded form inside the 32 MiB database budget.
  await assert.rejects(()=>encode(new ArrayBuffer(9*1024*1024)),/8 MiB/);
  await assert.rejects(()=>encode(new Uint8Array(9*1024*1024)),/8 MiB/);
  const eightMiB=new Uint8Array(8*1024*1024);eightMiB[0]=255;eightMiB[eightMiB.length-1]=7;
  const eightEncoded=await encode(eightMiB);
  assert(JSON.stringify(eightEncoded).length<32*1024*1024);
  const eightRestored=decode(JSON.parse(JSON.stringify(eightEncoded)));
  assert.equal(eightRestored.byteLength,8*1024*1024);
  assert.equal(eightRestored[0],255);
  assert.equal(eightRestored[eightRestored.length-1],7);
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
