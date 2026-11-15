'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { loadConfig } = require('../src/config.cjs');
const { Store } = require('../src/store.cjs');
const { createVodafoneAuth } = require('../src/auth.cjs');
const { sessionExpiry } = require('../src/session.cjs');
const { createApplication } = require('../src/app.cjs');
const { VodaLensClient } = require('../../../packages/backend-client/src/index.cjs');
const NOW = Date.parse('2026-11-15T00:00:00Z');
const TOKEN = 'test-backend-session-token-longer-than-thirty-two-characters';
const accessToken = (expiry = NOW / 1000 + 3600, marker = 'signature') => `header.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.${marker}`;
function fixture(t, response = { ok: true, json: async () => ({ accountDetails: [{ testAccount: true }] }) }) {
  const config = loadConfig({ VODALENS_API_TOKEN: TOKEN, VODALENS_VAULT_KEY: randomBytes(32).toString('base64') });
  const store = new Store({ filename: ':memory:', key: config.vaultKey, clock: () => NOW });
  const requests = [];
  const auth = createVodafoneAuth({ config, store, clock: () => NOW, fetchImpl: async (url, options) => { requests.push({ url, options }); return response; } });
  t.after(() => store.close());
  return { config, store, auth, requests };
}
test('session mode is the default and needs no registered client', t => {
  const { auth } = fixture(t);
  assert.equal(auth.status('owner').registrationRequired, false);
  assert.equal(auth.status('owner').connected, false);
  for (const stream of ['edge', 'ios', 'android']) assert.equal(auth.start('owner', stream).loginUrl, 'https://my.vodafone.com.au/');
});
test('session handoff verifies the consumer API and returns no Vodafone credential', async t => {
  const { auth, requests, store } = fixture(t), token = accessToken();
  const status = await auth.importSession('owner', { source: 'myvodafone-browser', accessToken: token });
  assert.equal(status.connected, true); assert.equal(status.allGatesPassed, false);
  assert.equal(status.automaticRefreshSupported, false);
  assert.equal(status.proof.sessionReplacementVerified, false);
  assert.equal(requests.length, 1); assert.match(requests[0].url, /\/planDetails$/);
  assert.equal(requests[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal(store.connection('owner').tokens.refreshToken, null);
  const raw = store.db.prepare('SELECT tokens_ciphertext FROM connections').get().tokens_ciphertext;
  assert.equal(raw.includes(token), false);
});
test('expired tokens and unexpected refresh credentials are rejected before API requests', async t => {
  const { auth, requests } = fixture(t);
  await assert.rejects(auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken(NOW / 1000 - 1) }), error => error.code === 'session_expired');
  await assert.rejects(auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken(), refreshToken: 'not-accepted' }), error => error.code === 'unsupported_credentials');
  await assert.rejects(auth.importSession('owner', { source: 'untrusted', accessToken: accessToken() }));
  assert.equal(requests.length, 0);
  assert.equal(sessionExpiry('opaque-token-without-jwt', NOW), NOW + 600000);
  assert.equal(sessionExpiry(accessToken(NOW / 1000 + 864000), NOW), NOW + 86400000);
});
test('a rejected session does not overwrite a previously working connection', async t => {
  const { auth, store } = fixture(t, { ok: false, status: 403 });
  const previous = { accessToken: 'existing-token-value', expiresAt: NOW + 60000 };
  store.saveConnection('owner', previous, { method: 'myvodafone-session', consumerApiRead: true });
  await assert.rejects(auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken() }));
  assert.equal(store.connection('owner').tokens.accessToken, previous.accessToken);
});
test('a generic successful response with empty account data cannot establish a connection', async t => {
  const { auth, store } = fixture(t, { ok: true, json: async () => ({ accountDetails: [] }) });
  await assert.rejects(auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken() }), error => error.code === 'unexpected_api_response');
  assert.equal(store.connection('owner'), null);
});
test('replacement browser tokens are verified, and a 401 requires reconnection without any OAuth call', async t => {
  const { auth, requests, store } = fixture(t);
  await auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken() });
  const status = await auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken(NOW / 1000 + 7200, 'replacement') });
  assert.equal(status.proof.sessionReplacementVerified, true);
  assert.equal(status.allGatesPassed, true);
  await assert.rejects(auth.accessToken('owner', { forceRefresh: true }), error => error.code === 'reconnect_required');
  assert.equal(store.connection('owner').tokens.accessToken, null);
  assert.equal(auth.status('owner').connected, false);
  assert.ok(requests.every(request => request.options.method === 'GET'));
  assert.ok(requests.every(request => !request.url.includes('/oauth/token')));
});
test('expired browser sessions stop being usable and disconnect removes the stored token', async t => {
  const { auth, store } = fixture(t);
  store.saveConnection('owner', { accessToken: accessToken(), expiresAt: NOW - 1 }, { method: 'myvodafone-session', consumerApiRead: true });
  assert.equal(auth.status('owner').state, 'reconnect_required');
  await assert.rejects(auth.accessToken('owner'), error => error.code === 'reconnect_required');
  const reconnected = await auth.importSession('owner', { source: 'myvodafone-browser', accessToken: accessToken(NOW / 1000 + 7200, 'new-after-expiry') });
  assert.equal(reconnected.proof.sessionReplacementVerified, true);
  assert.equal(auth.disconnect('owner').connected, false);
  assert.equal(store.connection('owner'), null);
});
test('an old request cannot invalidate a newly verified replacement session', async t => {
  const { auth } = fixture(t), old = accessToken(), fresh = accessToken(NOW / 1000 + 7200, 'fresh');
  await auth.importSession('owner', { source: 'myvodafone-browser', accessToken: old });
  await auth.importSession('owner', { source: 'myvodafone-browser', accessToken: fresh });
  assert.equal(await auth.accessToken('owner', { forceRefresh: true, rejectedToken: old }), fresh);
  assert.equal(auth.status('owner').connected, true);
});
test('a provider-rejected stored session clears its usable token and requires reconnection', async t => {
  const { auth, store, requests } = fixture(t, { ok: false, status: 401 });
  store.saveConnection('owner', { accessToken: accessToken(), expiresAt: NOW + 3600000 }, { method: 'myvodafone-session', consumerApiRead: true });
  await assert.rejects(auth.verify('owner'), error => error.code === 'reconnect_required');
  assert.equal(store.connection('owner').tokens.accessToken, null);
  assert.equal(auth.status('owner').state, 'reconnect_required');
  assert.equal(requests.length, 1);
});
test('session HTTP contract works through the shared SDK and rejects independent refresh', async t => {
  const { auth, store, config } = fixture(t);
  const server = createApplication({ config, store, auth, clock: () => NOW });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new VodaLensClient({ baseUrl: origin, getSessionToken: () => TOKEN });
  assert.equal((await client.capabilities()).authMethod, 'myvodafone-session');
  assert.equal((await client.connectMyVodafone(accessToken())).connected, true);
  assert.equal((await client.verifySession()).proof.consumerApiRead, true);
  await assert.rejects(client.verifyRefresh(), error => error.code === 'browser_renewal_required');
  assert.equal((await client.authStatus()).connected, true);
  assert.equal((await client.disconnectVodafone()).connected, false);
  const unauthorized = await fetch(origin + '/v1/auth/vodafone/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: accessToken() }) });
  assert.equal(unauthorized.status, 401);
});
