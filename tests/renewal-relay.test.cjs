'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../apps/edge/session-bridge/relay.js'), 'utf8');
const CLIENT = 'TE6munQ7o6txJRqZeSzLBzDECX1yVBJO';
const KEY = `@@auth0spajs@@::${CLIENT}::https://dsapi.vodafone.com.au::openid profile email offline_access`;
const NOW = Date.parse('2026-11-15T02:00:00Z');
const REFRESH = 'private-browser-refresh-credential';
function relay({ expiry = NOW + 300000, enabled = true } = {}) {
  let listener;
  const body = { client_id: CLIENT, audience: 'https://dsapi.vodafone.com.au', refresh_token: REFRESH, access_token: `header.${Buffer.from(JSON.stringify({ exp: expiry / 1000 })).toString('base64url')}.signature` };
  const storage = { [KEY]: JSON.stringify({ body }), unrelated: 'preserve-this' };
  Object.defineProperties(storage, { getItem: { value: key => storage[key] || null }, removeItem: { value: key => { delete storage[key]; } } });
  const window = { addEventListener() {} }; window.top = window;
  const context = vm.createContext({ window, location: { origin: 'https://my.vodafone.com.au' }, localStorage: storage, atob, Date: class extends Date { static now() { return NOW; } }, chrome: { runtime: { id: 'trusted', getURL: file => 'chrome-extension://trusted/' + file, onMessage: { addListener: fn => { listener = fn; } } } } });
  vm.runInContext(enabled ? source.replace('const RESEARCH_ENABLED = false;', 'const RESEARCH_ENABLED = true;') : source, context);
  const sender = { id: 'trusted', url: 'chrome-extension://trusted/background.js' };
  const send = (message, from = sender) => { let result; listener(message, from, value => { result = value; }); return result; };
  return { storage, body, send };
}
test('refresh credential is unavailable to page messages and other extensions', () => {
  const { send } = relay();
  const message = { type: 'prepareRenewalResearch', probeId: 'test-id' };
  assert.equal(send(message, { id: 'other', url: 'chrome-extension://other/background.js' }), undefined);
  assert.equal(send(message, { id: 'trusted', tab: { id: 1 }, url: 'https://my.vodafone.com.au/' }), undefined);
});
test('browser cache survives preparation and only its approved credential entry is retired', () => {
  const { storage, send } = relay();
  const prepared = send({ type: 'prepareRenewalResearch', probeId: 'test-id' });
  assert.equal(prepared.refreshToken, REFRESH); assert.ok(storage[KEY]);
  assert.equal(send({ type: 'retireRenewalCredential', probeId: 'test-id' }).retired, true);
  assert.equal(storage[KEY], undefined); assert.equal(storage.unrelated, 'preserve-this');
});
test('a cache changed by Vodafone cannot be deleted or transferred as the old credential', () => {
  const { storage, body, send } = relay();
  send({ type: 'prepareRenewalResearch', probeId: 'test-id' });
  storage[KEY] = JSON.stringify({ body: { ...body, refresh_token: 'new-private-refresh-credential' } });
  assert.equal(send({ type: 'retireRenewalCredential', probeId: 'test-id' }).errorCode, 'renewal_cache_unavailable');
  assert.ok(storage[KEY].includes('new-private-refresh-credential'));
});
test('expired or nearly expired browser sessions never export a refresh credential', () => {
  const { send } = relay({ expiry: NOW + 60000 });
  const result = send({ type: 'prepareRenewalResearch', probeId: 'test-id' });
  assert.equal(result.errorCode, 'renewal_stale_page'); assert.equal(result.refreshToken, undefined);
});

test('default relay refuses refresh export even from its own background worker', () => {
  const { send, storage } = relay({ enabled: false });
  const result = send({ type: 'prepareRenewalResearch', probeId: 'test-id' });
  assert.equal(result.errorCode, 'research_disabled');
  assert.equal(result.refreshToken, undefined);
  assert.ok(storage[KEY]);
});
