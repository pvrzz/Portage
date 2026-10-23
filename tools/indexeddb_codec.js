/* Portable, lossless subset of IndexedDB structured-clone values.
   Unsupported types and shared/cyclic references are refused, never silently discarded. */
'use strict';
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function assertBinaryLimit(bytes, label) {
  if (bytes > MAX_BINARY_BYTES) throw new Error(label + ' larger than 8 MiB migration limit');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  if (typeof text !== 'string') throw new Error('Invalid base64 binary payload');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Typed arrays are stored as raw bytes plus the source host's byte order. If
// the destination host uses the opposite order, swap each element so a
// big-endian migration cannot silently byte-swap numeric values.
function swapBytes(bytes, bytesPerElement) {
  for (let i = 0; i < bytes.length; i += bytesPerElement) {
    for (let j = 0; j < bytesPerElement / 2; j++) {
      const a = i + j, b = i + bytesPerElement - 1 - j;
      const tmp = bytes[a]; bytes[a] = bytes[b]; bytes[b] = tmp;
    }
  }
  return bytes;
}

function encodeNumber(value) {
  return {t: 'number', v: Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value)};
}

async function encode(value, seen = new WeakSet()) {
  if (value === null) return {t:'null'};
  const typ = typeof value;
  if (typ === 'undefined') return {t:'undefined'};
  if (typ === 'string' || typ === 'boolean') return {t:typ,v:value};
  if (typ === 'bigint') return {t:'bigint',v:value.toString()};
  if (typ === 'number') return encodeNumber(value);
  if (typ !== 'object') throw new Error('Unsupported IndexedDB value type: '+typ);
  if(seen.has(value)) throw new Error('Shared/cyclic references cannot yet be migrated losslessly');
  seen.add(value);
  if(value instanceof Date) return {t:'date',v:Number.isNaN(value.getTime())?'NaN':value.getTime()};
  if(value instanceof RegExp) return {t:'regexp',s:value.source,f:value.flags};
  if(value instanceof ArrayBuffer){
    assertBinaryLimit(value.byteLength,'ArrayBuffer');
    return {t:'buffer',v:bytesToBase64(new Uint8Array(value))};
  }
  if(ArrayBuffer.isView(value)) {
    assertBinaryLimit(value.byteLength,value.constructor.name);
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof DataView) return {t:'dataview',v:bytesToBase64(bytes)};
    return {t:'typedarray',type:value.constructor.name,v:bytesToBase64(bytes),le:LITTLE_ENDIAN};
  }
  if(typeof Blob !== 'undefined' && value instanceof Blob){
    assertBinaryLimit(value.size, value instanceof File ? 'File' : 'Blob');
    const bytes = new Uint8Array(await value.arrayBuffer());
    if(typeof File !== 'undefined' && value instanceof File){
      return {t:'file',v:bytesToBase64(bytes),name:value.name,mime:value.type,lastModified:value.lastModified};
    }
    return {t:'blob',v:bytesToBase64(bytes),mime:value.type};
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
  // Structured-cloneable built-ins that are not plain objects.
  if(value instanceof Error){
    const encoded={t:'error',name:value.name,message:value.message,stack:value.stack};
    if(Object.prototype.hasOwnProperty.call(value,'cause')) encoded.cause=await encode(value.cause,seen);
    return encoded;
  }
  const tag=Object.prototype.toString.call(value);
  if(tag==='[object Number]')return {t:'numberobject',v:encodeNumber(value.valueOf())};
  if(tag==='[object String]')return {t:'stringobject',v:value.valueOf()};
  if(tag==='[object Boolean]')return {t:'booleanobject',v:value.valueOf()};
  if(typeof ImageData!=='undefined' && value instanceof ImageData){
    assertBinaryLimit(value.data.byteLength,'ImageData');
    return {t:'imagedata',w:value.width,h:value.height,
      data:bytesToBase64(new Uint8Array(value.data.buffer,value.data.byteOffset,value.data.byteLength))};
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
    case 'buffer':return base64ToBytes(o.v).buffer;
    case 'dataview':return new DataView(base64ToBytes(o.v).buffer);
    case 'typedarray': {
      const types={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array};
      if(typeof Float16Array!=='undefined')types.Float16Array=Float16Array;
      const ctor=types[o.type]; if(!ctor)throw new Error('Unknown typed array type');
      const a=base64ToBytes(o.v); if(a.byteLength%ctor.BYTES_PER_ELEMENT)throw new Error('Invalid typed array data');
      if(o.le!==undefined && o.le!==LITTLE_ENDIAN && ctor.BYTES_PER_ELEMENT>1)swapBytes(a,ctor.BYTES_PER_ELEMENT);
      return new ctor(a.buffer);
    }
    case 'blob':return new Blob([base64ToBytes(o.v)],{type:o.mime});
    case 'file':return new File([base64ToBytes(o.v)],o.name,{type:o.mime,lastModified:o.lastModified});
    case 'error': {
      const types={Error,TypeError,RangeError,SyntaxError,ReferenceError,EvalError,URIError};
      const Ctor=types[o.name]||Error;
      const error=new Ctor(o.message||'');
      if(o.name)error.name=o.name;
      if(o.stack)error.stack=o.stack;
      if('cause' in o)error.cause=decode(o.cause);
      return error;
    }
    case 'numberobject':return new Number(decode(o.v));
    case 'stringobject':return new String(o.v);
    case 'booleanobject':return new Boolean(o.v);
    case 'imagedata': {
      if(typeof ImageData==='undefined')throw new Error('ImageData is not supported in this browser');
      return new ImageData(new Uint8ClampedArray(base64ToBytes(o.data)),o.w,o.h);
    }
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
if(typeof module !== 'undefined' && module.exports)module.exports={encode,decode,MAX_BINARY_BYTES};
else Object.defineProperty(globalThis,'PortageIDBCodec',{value:Object.freeze({encode,decode}),writable:false,configurable:false});
