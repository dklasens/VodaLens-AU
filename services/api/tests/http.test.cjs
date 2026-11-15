'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { loadConfig } = require('../src/config.cjs');
const { Store } = require('../src/store.cjs');
const { VodafoneAuth } = require('../src/oauth.cjs');
const { createApplication } = require('../src/app.cjs');
const { VodaLensClient } = require('../../../packages/backend-client/src/index.cjs');
const NOW = Date.parse('2026-11-15T00:00:00Z');
const TOKEN = 'test-backend-credential-longer-than-thirty-two-characters';
async function fixture(t, { registered = true } = {}) {
  const config = loadConfig({ VODALENS_API_TOKEN: TOKEN, VODALENS_VAULT_KEY: randomBytes(32).toString('base64'), VODAFONE_CLIENT_ID: registered ? 'test-vodalens-client' : '', ALLOWED_CLIENT_ORIGINS: 'http://127.0.0.1:8765' });
  const store = new Store({ filename: ':memory:', key: config.vaultKey, clock: () => NOW });
  const upstream = [];
  const fetchImpl = async (url, options) => {
    upstream.push({ url, ...options });
    const pathname = new URL(url).pathname;
    if (pathname === '/oauth/token') return { ok: true, json: async () => ({ access_token: 'private-upstream-access', refresh_token: 'private-upstream-refresh', expires_in: 3600, token_type: 'Bearer' }) };
    if (pathname.endsWith('/planDetails')) return { ok: true, json: async () => ({ accountDetails: { accountDetail: { accountNumber: 'private-test-account', billingAccount: [{ BAN: 'private-test-billing-account', asset: [{ msisdn: '61400000001', displayPlanName: 'Test plan', accountType: 'Postpaid', serviceType: 'Mobile' }] }] } } }) };
    if (pathname.endsWith('/usage')) return { ok: true, json: async () => [100, 50].map((bytes, index) => ({ id: 'Data', usageType: 'Data', usageDate: `2026-11-15T00:00:0${index}.000`, usageCharacteristic: [{ name: 'data-BYTES', value: String(bytes) }] })) };
    throw new Error('Unexpected provider request');
  };
  const auth = new VodafoneAuth({ config, store, fetchImpl, clock: () => NOW });
  const server = createApplication({ config, store, auth, clock: () => NOW });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); });
  const request = (pathname, { body, token = TOKEN, headers, ...options } = {}) => fetch(origin + pathname, { ...options, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const connect = async () => {
    const start = await request('/v1/auth/vodafone/start', { method: 'POST', body: { stream: 'edge' } });
    const { authorizationUrl } = await start.json(), state = new URL(authorizationUrl).searchParams.get('state');
    return request(`/oauth/vodafone/callback?state=${state}&code=test-code`, { token: null });
  };
  return { request, connect, origin, store, auth, upstream };
}
test('HTTP health and capabilities report all streams without pretending Vodafone is connected', async t => {
  const { request } = await fixture(t, { registered: false });
  assert.equal((await request('/healthz', { token: null })).status, 200);
  const capabilities = await (await request('/v1/capabilities', { token: null })).json();
  assert.deepEqual(capabilities.streams, ['edge', 'ios', 'android']);
  assert.equal(capabilities.registrationRequired, true);
  const response = await request('/v1/auth/vodafone/start', { method: 'POST', body: { stream: 'edge' } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'registration_required');
});
test('HTTP API requires a backend session and exact browser origin', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/v1/auth/vodafone/status', { token: null })).status, 401);
  assert.equal((await request('/v1/auth/vodafone/status', { token: 'wrong' })).status, 401);
  assert.equal((await request('/v1/auth/vodafone/status', { headers: { origin: 'https://unconfigured.example' } })).status, 403);
  const allowed = await request('/v1/auth/vodafone/status', { headers: { origin: 'http://127.0.0.1:8765' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8765');
});
test('HTTP callback never returns upstream credentials and is one use', async t => {
  const { request } = await fixture(t);
  const start = await request('/v1/auth/vodafone/start', { method: 'POST', body: { stream: 'ios' } });
  const { authorizationUrl } = await start.json(), state = new URL(authorizationUrl).searchParams.get('state');
  const path = `/oauth/vodafone/callback?state=${state}&code=test-code`;
  const callback = await request(path, { token: null });
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!(await callback.text()).includes('private-upstream'));
  assert.equal((await request(path, { token: null })).status, 400);
  const status = await (await request('/v1/auth/vodafone/status')).json();
  assert.equal(status.proof.consumerApiRead, true); assert.equal(status.allGatesPassed, false);
  const refreshed = await (await request('/v1/auth/vodafone/verify-refresh', { method: 'POST', body: {} })).json();
  assert.equal(refreshed.allGatesPassed, true);
  assert.ok(!JSON.stringify(refreshed).includes('private-upstream'));
});
test('HTTP cached gaps stay unknown until an API date window is synced', async t => {
  const { request, connect, store } = await fixture(t);
  const query = 'service=0400000001&start=2026-11-14&end=2026-11-15';
  const empty = await (await request('/v1/usage/history?' + query)).json();
  assert.deepEqual(empty.daily.map(day => day.bytes), [null, null]);
  assert.equal(empty.windowCoverageComplete, false);
  assert.equal((await connect()).status, 200);
  for (let i = 0; i < 2; i++) {
    const synced = await request('/v1/usage/sync', { method: 'POST', body: { service: '0400000001', start: '2026-11-14', end: '2026-11-15' } });
    assert.equal(synced.status, 200); assert.equal((await synced.json()).recordCount, 2);
  }
  const result = await (await request('/v1/usage/history?' + query)).json();
  assert.deepEqual(result.daily.map(day => day.bytes), [0, 150]); assert.equal(result.windowCoverageComplete, true);
  assert.equal(result.providerCompletenessVerified, false);
  assert.equal(store.history('different-owner', '0400000001', '2026-11-14', '2026-11-16').records.length, 0);
  assert.equal(store.history('personal-owner', '0400000001', '2026-11-14', '2026-11-16').records.length, 2);
});
test('HTTP service discovery reads the provider account and omits account identifiers', async t => {
  const { request, connect } = await fixture(t);
  assert.equal((await request('/v1/services')).status, 409);
  assert.equal((await connect()).status, 200);
  const response = await request('/v1/services');
  assert.equal(response.status, 200);
  const roster = await response.json();
  assert.equal(roster.services.length, 1);
  assert.equal(roster.services[0].phone, '0400000001');
  assert.equal(roster.services[0].planName, 'Test plan');
  assert.equal(JSON.stringify(roster).includes('private-test-account'), false);
  assert.equal(JSON.stringify(roster).includes('private-test-billing-account'), false);
});
test('HTTP rejects malformed requests, invalid dates and callback parameter duplication', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/v1/usage/sync', { method: 'POST', body: { service: 'invalid', start: '2026-11-15', end: '2026-11-15' } })).status, 400);
  assert.equal((await request('/v1/usage/history?service=0400000001&start=2026-02-30&end=2026-11-15')).status, 400);
  assert.equal((await request('/v1/usage/history?service=0400000001&start=2026-11-15&end=2026-11-16')).status, 400);
  assert.equal((await request('/v1/auth/vodafone/start', { method: 'POST', body: { stream: 'android' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/oauth/vodafone/callback?state=a&state=b&code=c', { token: null })).status, 400);
});
test('shared client supports each platform and sends only the backend session to the backend', async t => {
  const { origin } = await fixture(t);
  const client = new VodaLensClient({ baseUrl: origin, getSessionToken: async () => TOKEN });
  assert.deepEqual((await client.capabilities()).streams, ['edge', 'ios', 'android']);
  for (const stream of ['edge', 'ios', 'android']) assert.equal((await client.startVodafoneSignIn(stream)).stream, stream);
  await assert.rejects(client.request('https://external.example/v1/steal'), /configured VodaLens backend/);
  assert.throws(() => new VodaLensClient({ baseUrl: 'http://public.example', getSessionToken: () => TOKEN }), /HTTPS/);
});
