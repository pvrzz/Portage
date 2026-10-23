'use strict';
// Exercises the dashboard's cookie collection/import code in a VM with mocked
// WebExtension APIs; no real browser profile is read or written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {validOrigin, validateBundle} = require('../tools/chromium_localstorage_import.cjs');

function browserContext(browser) {
  const source = fs.readFileSync(`${browser}/dashboard.js`, 'utf8');
  const context = vm.createContext({
    URL, Number, Array, String, Object, IS_FIREFOX: browser === 'firefox', tick: async () => {},
  });
  for (const [startMarker, endMarker] of [
    ['async function collectCookies()', 'async function collectTabs()'],
    ['function mapSameSite(s)', 'async function importTabs('],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert(start > 0 && end > start, `${browser}: missing ${startMarker}`);
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

async function main() {
  for (const browser of ['chrome', 'firefox']) {
    const firefox = browser === 'firefox';
    const context = browserContext(browser);
    const defaultStoreId = firefox ? 'firefox-default' : '0';

    for (const sameSite of ['strict', 'lax', 'no_restriction', 'unspecified']) {
      assert.equal(context.mapSameSite(sameSite), sameSite);
    }
    assert.equal(context.mapSameSite(undefined), 'unspecified');
    assert.equal(context.mapSameSite('unknown'), 'unspecified');

    // collectCookies: partitioned cookies must be requested explicitly for
    // both browsers; a store that cannot be read must not abort the scan.
    const queries = [];
    context.api = {
      cookies: {
        getAllCookieStores: async () => [
          {id: defaultStoreId}, {id: firefox ? 'firefox-container-1' : '1'}, {id: 'unreadable-store'},
        ],
        getAll: async (query) => {
          queries.push({...query});
          if (query.storeId === 'unreadable-store') throw new Error('store is not accessible');
          return [{
            name: 'cookie-' + query.storeId, value: 'v', domain: 'example.com', path: '/',
            secure: true, httpOnly: true, sameSite: 'lax', session: true, hostOnly: true,
            storeId: query.storeId, partitionKey: {topLevelSite: 'https://top.test', hasCrossSiteAncestor: false},
            firstPartyDomain: firefox ? '' : undefined,
          }];
        },
      },
    };
    const collected = await context.collectCookies();
    assert.equal(queries.length, 3);
    for (const query of queries) {
      assert.equal(Object.keys(query.partitionKey).length, 0, `${browser}: partitionKey filter missing`);
      assert.equal(typeof query.storeId, 'string');
      if (firefox) assert.equal(query.firstPartyDomain, null);
      else assert.equal('firstPartyDomain' in query, false, 'Chrome rejects unknown firstPartyDomain');
    }
    assert.equal(collected.count, 2, `${browser}: unreadable store aborted collection`);
    assert.equal(collected.data[0].partitionKey.topLevelSite, 'https://top.test');

    // importCookies: only the browser default store is a valid target, and
    // partitioned/FPI metadata must survive the conversion.
    const written = [];
    context.api = {cookies: {set: async (details) => { written.push(details); return details; }}};
    const result = await context.importCookies([
      {name: 'plain', value: 'v', domain: 'example.com', path: '/', hostOnly: true, sameSite: undefined},
      {name: 'partitioned', value: 'v', domain: 'example.com', path: '/', hostOnly: true, sameSite: 'lax',
        partitionKey: {topLevelSite: 'https://top.test', hasCrossSiteAncestor: true}},
      {name: 'container', value: 'v', domain: 'example.com', path: '/', storeId: 'firefox-container-1'},
      {name: 'incognito', value: 'v', domain: 'example.com', path: '/', storeId: '1'},
      {name: 'fpi', value: 'v', domain: 'example.com', path: '/', firstPartyDomain: 'example.com'},
    ], () => {});
    const names = written.map((details) => details.name);
    assert.equal(result.imported, firefox ? 3 : 2, `${browser}: unexpected import count`);
    assert.equal(result.skipped, firefox ? 2 : 3, `${browser}: unexpected skip count`);
    assert.deepEqual(names, firefox ? ['plain', 'partitioned', 'fpi'] : ['plain', 'partitioned']);
    for (const details of written) assert.equal(details.storeId, defaultStoreId);
    assert.equal('sameSite' in written[0], false, 'unspecified must omit the attribute');
    assert.equal(written.find((details) => details.name === 'partitioned').partitionKey.hasCrossSiteAncestor, true);
    if (firefox) {
      assert.equal(written[0].firstPartyDomain, '');
      assert.equal(written.find((details) => details.name === 'fpi').firstPartyDomain, 'example.com');
    }
    console.log(`${browser}: cookie collect/import metadata, partitioning, SameSite passed`);
  }

  assert(validOrigin('https://example.org'));
  assert(!validOrigin('javascript:foo'));
  assert.throws(() => validateBundle({portage: {format: 'portage-bundle', version: 1},
    data: {localStorage: [{origin: 'https://example.org/path', items: {x: 'y'}}]}}));
  assert.throws(() => validateBundle({portage: {format: 'portage-bundle', version: 1},
    data: {localStorage: [{origin: 'https://example.org', items: {x: 123}}]}}));

  // A __proto__ storage key is data, not a prototype mutation; JSON.parse
  // defines it as an own property, and validateBundle must accept it.
  const protoBundle = JSON.parse('{"portage":{"format":"portage-bundle","version":1},' +
    '"data":{"localStorage":[{"origin":"https://example.org","items":{"__proto__":"value"}}]}}');
  const protoItems = validateBundle(protoBundle).sites[0].items;
  assert.equal(Object.getPrototypeOf(protoItems), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(protoItems, '__proto__'), true);
  assert.equal(protoItems['__proto__'], 'value');
  console.log('PASS: dashboard cookies and bundle validation');
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
