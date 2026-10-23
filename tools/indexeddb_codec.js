/* Portable, lossless subset of IndexedDB structured-clone values.
   Unsupported types and cyclic/shared references are refused, never silently discarded. */
'use strict';
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
function assertBinaryLimit(bytes, label) {
  if (bytes > MAX_BINARY_BYTES) throw new Error(label + ' larger than 8 MiB migration limit');
}
async function encode(value, seen = new WeakSet()) {
  if (value === null) return {t:'null'};
  const typ = typeof value;
  if (typ === 'undefined') return {t:'undefined'};
  if (typ === 'string' || typ === 'boolean') return {t:typ,v:value};
  if (typ === 'bigint') return {t:'bigint',v:value.toString()};
  if (typ === 'number') return {t:'number',v:Object.is(value,-0)?'-0':Number.isFinite(value)?value:String(value)};
  if (typ !== 'object') throw new Error('Unsupported IndexedDB value type: '+typ);
  if(seen.has(value)) throw new Error('Shared/cyclic references cannot yet be migrated losslessly');
  seen.add(value);
  if(value instanceof Date) return {t:'date',v:Number.isNaN(value.getTime())?'NaN':value.getTime()};
  if(value instanceof RegExp) return {t:'regexp',s:value.source,f:value.flags};
  if(value instanceof ArrayBuffer){
    assertBinaryLimit(value.byteLength,'ArrayBuffer');
    return {t:'buffer',v:Array.from(new Uint8Array(value))};
  }
  if(ArrayBuffer.isView(value)) {
    assertBinaryLimit(value.byteLength,value.constructor.name);
    if (value instanceof DataView) return {t:'dataview',v:Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))};
    return {t:'typedarray',type:value.constructor.name,v:Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))};
  }
  if(typeof Blob !== 'undefined' && value instanceof Blob){
    assertBinaryLimit(value.size, value instanceof File ? 'File' : 'Blob');
    const v=Array.from(new Uint8Array(await value.arrayBuffer()));
    if(typeof File !== 'undefined' && value instanceof File)return {t:'file',v,name:value.name,mime:value.type,lastModified:value.lastModified};
    return {t:'blob',v,mime:value.type};
  }
  if(Array.isArray(value)) {
    if(value.length>50000)throw new Error('Array exceeds migration length limit');
    const items=[];
    for(let i=0;i<value.length;i++) items.push(Object.prototype.hasOwnProperty.call(value,i)?await encode(value[i],seen):{t:'hole'});
    // Preserve custom enumerable properties, not only numeric array elements.
    const extras=[];
    for(const k of Object.keys(value)) {
      if(/^(0|[1-9][0-9]*)$/.test(k) && Number(k)<value.length)continue;
      extras.push([k,await encode(value[k],seen)]);
    }
    return {t:'array',v:items,extras};
  }
  if(value instanceof Map) {
    const pairs=[];for(const [k,v] of value) pairs.push([await encode(k,seen),await encode(v,seen)]);
    return {t:'map',v:pairs};
  }
  if(value instanceof Set) {
    const arr=[];for(const v of value)arr.push(await encode(v,seen));return {t:'set',v:arr};
  }
  if(Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)
    throw new Error('Unsupported IndexedDB object prototype');
  const pairs=[];
  for (const k of Object.keys(value)) pairs.push([k,await encode(value[k],seen)]);
  return {t:'object',plain:Object.getPrototypeOf(value)===Object.prototype,v:pairs};
}
function decode(o){
  if(!o || typeof o.t!=='string')throw new Error('Invalid encoded value');
  switch(o.t){
    case 'null':return null;
    case 'undefined':return undefined;
    case 'string':case 'boolean':return o.v;
    case 'number':return typeof o.v==='number'?o.v:Number(o.v);
    case 'bigint':return BigInt(o.v);
    case 'date':return new Date(o.v);
    case 'regexp':return new RegExp(o.s,o.f);
    case 'buffer':return Uint8Array.from(o.v).buffer;
    case 'dataview':return new DataView(Uint8Array.from(o.v).buffer);
    case 'typedarray': {
      const types={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array};
      const ctor=types[o.type]; if(!ctor)throw new Error('Unknown typed array type');
      const a=Uint8Array.from(o.v); if(a.byteLength%ctor.BYTES_PER_ELEMENT)throw new Error('Invalid typed array data');
      return new ctor(a.buffer);
    }
    case 'blob':return new Blob([Uint8Array.from(o.v)],{type:o.mime});
    case 'file':return new File([Uint8Array.from(o.v)],o.name,{type:o.mime,lastModified:o.lastModified});
    case 'array': {
      const arr=new Array(o.v.length);
      for(let i=0;i<o.v.length;i++)if(o.v[i].t!=='hole')arr[i]=decode(o.v[i]);
      for(const [k,v]of (o.extras||[]))Object.defineProperty(arr,k,{value:decode(v),enumerable:true,writable:true,configurable:true});
      return arr;
    }
    case 'map':return new Map(o.v.map(([k,v])=>[decode(k),decode(v)]));
    case 'set':return new Set(o.v.map(decode));
    case 'object': {
      const obj=o.plain===false?Object.create(null):{};
      for(const [k,v]of o.v)Object.defineProperty(obj,k,{value:decode(v),enumerable:true,writable:true,configurable:true});
      return obj;
    }
    default:throw new Error('Unknown structured clone value: '+o.t);
  }
}
// CommonJS for unit tests; browser global for the inert migration document.
if(typeof module !== 'undefined' && module.exports)module.exports={encode,decode};
else Object.defineProperty(globalThis,'PortageIDBCodec',{value:Object.freeze({encode,decode}),writable:false,configurable:false});
