'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { loadConfig } = require('../src/config.cjs');
const { Store } = require('../src/store.cjs');
const { VodafoneAuth, challenge } = require('../src/oauth.cjs');
const NOW = Date.parse('2026-11-15T00:00:00Z');
function config(overrides = {}) {
  return loadConfig({ VODALENS_API_TOKEN: 'test-backend-session-token-of-more-than-32-characters', VODALENS_VAULT_KEY: randomBytes(32).toString('base64'), VODAFONE_CLIENT_ID: 'test-vodalens-owned-client', ...overrides });
}
function fixture(t, { reply, configured = true } = {}) {
  const cfg = config(configured ? {} : { VODAFONE_CLIENT_ID: '' });
  const store = new Store({ filename: ':memory:', key: cfg.vaultKey, clock: () => NOW });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    if (reply) return reply(url, options, requests);
    if (new URL(url).pathname === '/oauth/token') {
      const form = new URLSearchParams(options.body);
      const rotated = form.get('grant_type') === 'refresh_token';
      return { ok: true, json: async () => ({ access_token: rotated ? 'rotated-access-secret' : 'initial-access-secret', refresh_token: rotated ? 'rotated-refresh-secret' : 'initial-refresh-secret', expires_in: 3600, token_type: 'Bearer' }) };
    }
    return { ok: true, json: async () => ({ accountDetails: [{ testAccount: true }] }) };
  };
  const auth = new VodafoneAuth({ config: cfg, store, fetchImpl, clock: () => NOW });
  t.after(() => store.close());
  return { cfg, store, auth, requests };
}
test('configuration rejects missing local credentials and public HTTP callbacks', () => {
  assert.throws(() => loadConfig({}), /VODALENS_API_TOKEN/);
  assert.throws(() => config({ PUBLIC_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.throws(() => config({ PUBLIC_ORIGIN: 'https://example.com/other' }), /without a path/);
  assert.throws(() => config({ VODALENS_VAULT_KEY: 'short' }), /32-byte/);
  assert.equal(config().redirectUri, 'http://127.0.0.1:8766/oauth/vodafone/callback');
});
test('all three streams use the same backend callback with independent PKCE states', t => {
  const { auth } = fixture(t);
  const states = new Set();
  for (const stream of ['edge', 'ios', 'android']) {
    const result = auth.start('owner', stream), url = new URL(result.authorizationUrl);
    assert.equal(url.origin, 'https://authn.vodafone.com.au');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8766/oauth/vodafone/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('audience'), 'https://dsapi.vodafone.com.au');
    assert.ok(!url.searchParams.has('code_verifier'));
    states.add(url.searchParams.get('state'));
  }
  assert.equal(states.size, 3);
  assert.throws(() => auth.start('owner', 'unknown'), /edge, ios or android/);
});
test('registration remains a real gate and cannot be inferred from provider discovery', t => {
  const { auth } = fixture(t, { configured: false });
  assert.throws(() => auth.start('owner', 'edge'), error => error.code === 'registration_required');
  assert.equal(auth.status('owner').allGatesPassed, false);
});
test('authorization exchange verifies PKCE and API access before recording a connection', async t => {
  const { auth, requests, store } = fixture(t);
  const url = new URL(auth.start('owner', 'edge').authorizationUrl), state = url.searchParams.get('state');
  await auth.callback({ state, code: 'single-use-test-code' });
  const form = new URLSearchParams(requests[0].body);
  assert.equal(challenge(form.get('code_verifier')), url.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:8766/oauth/vodafone/callback');
  assert.equal(requests[1].headers.authorization, 'Bearer initial-access-secret');
  assert.equal(store.connection('owner').tokens.refreshToken, 'initial-refresh-secret');
  const status = auth.status('owner');
  assert.equal(status.proof.authorizationCode, true); assert.equal(status.proof.consumerApiRead, true);
  assert.equal(status.allGatesPassed, false);
  assert.ok(!JSON.stringify(status).includes('secret'));
  await assert.rejects(auth.callback({ state, code: 'single-use-test-code' }), error => error.code === 'invalid_state');
});
test('unknown, expired and denied authorization states are rejected without token exchange', async t => {
  const { auth, store, requests } = fixture(t);
  await assert.rejects(auth.callback({ state: 'unknown', code: 'code' }), error => error.code === 'invalid_state');
  store.saveTransaction({ state: 'expired', ownerId: 'owner', stream: 'edge', verifier: 'verifier', expiresAt: NOW - 1 });
  await assert.rejects(auth.callback({ state: 'expired', code: 'code' }), error => error.code === 'invalid_state');
  const state = new URL(auth.start('owner', 'ios').authorizationUrl).searchParams.get('state');
  await assert.rejects(auth.callback({ state, error: 'access_denied' }), error => error.code === 'authorization_denied');
  assert.equal(requests.length, 0);
});
test('refresh rotation is shared across concurrent platform requests and verifies the consumer API', async t => {
  const { auth, store, requests } = fixture(t);
  const state = new URL(auth.start('owner', 'ios').authorizationUrl).searchParams.get('state');
  await auth.callback({ state, code: 'code' });
  const result = await Promise.all(['edge', 'ios', 'android'].map(() => auth.accessToken('owner', { forceRefresh: true })));
  assert.deepEqual(result, ['rotated-access-secret', 'rotated-access-secret', 'rotated-access-secret']);
  assert.equal(requests.filter(r => new URL(r.url).pathname === '/oauth/token').length, 2);
  assert.equal(store.connection('owner').tokens.refreshToken, 'rotated-refresh-secret');
  assert.equal(auth.status('owner').allGatesPassed, true);
});
test('a rotated refresh token is retained if the subsequent API verification fails', async t => {
  let apiCalls = 0;
  const { auth, store } = fixture(t, { reply: async (url, options) => {
    if (new URL(url).pathname === '/oauth/token') {
      const refresh = new URLSearchParams(options.body).get('grant_type') === 'refresh_token';
      return { ok: true, json: async () => ({ access_token: 'access', refresh_token: refresh ? 'new-rotated-token' : 'old-token', token_type: 'Bearer', expires_in: 3600 }) };
    }
    return ++apiCalls === 1 ? { ok: true, json: async () => ({ accountDetails: [{ testAccount: true }] }) } : { ok: false, status: 503 };
  } });
  const state = new URL(auth.start('owner', 'android').authorizationUrl).searchParams.get('state');
  await auth.callback({ state, code: 'code' });
  await assert.rejects(auth.accessToken('owner', { forceRefresh: true }));
  assert.equal(store.connection('owner').tokens.refreshToken, 'new-rotated-token');
  assert.equal(auth.status('owner').allGatesPassed, false);
});
test('invalid refresh grant disconnects the expired connection', async t => {
  const { auth, store } = fixture(t, { reply: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'private provider response' }) }) });
  store.saveConnection('owner', { accessToken: 'access', refreshToken: 'refresh', expiresAt: NOW - 1 }, { authorizationCode: true });
  await assert.rejects(auth.accessToken('owner'), error => error.code === 'reauthentication_required' && !error.message.includes('private'));
  assert.equal(store.connection('owner'), null);
});
test('vault encrypts tokens and PKCE verifiers at rest and binds them to their owner', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vodalens-vault-'));
  const filename = path.join(directory, 'test.sqlite'), key = randomBytes(32);
  const store = new Store({ filename, key, clock: () => NOW });
  store.saveConnection('owner-a', { accessToken: 'plaintext-access-marker', refreshToken: 'plaintext-refresh-marker' }, { authorizationCode: true });
  store.saveTransaction({ state: 'public-state-marker', ownerId: 'owner-a', stream: 'edge', verifier: 'plaintext-pkce-marker', expiresAt: NOW + 10000 });
  const cipher = store.db.prepare('SELECT tokens_ciphertext FROM connections').get().tokens_ciphertext;
  assert.throws(() => store.open(cipher, 'tokens:owner-b'));
  store.close();
  for (const file of fs.readdirSync(directory)) {
    const bytes = fs.readFileSync(path.join(directory, file));
    for (const marker of ['plaintext-access-marker', 'plaintext-refresh-marker', 'plaintext-pkce-marker', 'public-state-marker']) assert.equal(bytes.includes(Buffer.from(marker)), false);
  }
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});
