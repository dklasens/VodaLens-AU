'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { Store } = require('../src/store.cjs');
const { createApplication } = require('../src/app.cjs');
const { RenewalResearch, armRenewalResearch, TOKEN_URL, CLIENT_ID, REDIRECT_URI } = require('../src/renewal-research.cjs');
const NOW = Date.parse('2026-11-15T02:00:00Z');
const ORIGINAL = 'private-original-refresh-credential';
function fixture(t, { failure, apiFailure = false, enabled = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vodalens-renewal-test-'));
  const evidenceFile = path.join(directory, 'evidence.json');
  let now = NOW, tokenRequests = 0;
  const store = new Store({ filename: ':memory:', key: randomBytes(32) });
  const config = { renewalResearchEnabled: enabled, publicOrigin: 'http://127.0.0.1:8766', authMethod: 'myvodafone-session', ownerId: 'test-owner', apiToken: 'private-development-api-token-longer-than-thirty-two-characters', allowedOrigins: [], streams: ['edge', 'ios', 'android'] };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, at: now });
    if (url === TOKEN_URL) {
      tokenRequests++;
      if (failure === 'timeout') throw new Error('private-provider-failure');
      if (failure === 'invalid_grant') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'private-provider-description' }) };
      return { ok: true, status: 200, json: async () => ({ access_token: `private-access-token-${tokenRequests}`, refresh_token: `private-rotated-refresh-${tokenRequests}`, token_type: 'Bearer', expires_in: 300 }) };
    }
    if (apiFailure) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => ({ accountDetails: { accountDetail: { billingAccount: [{ asset: [{ msisdn: '61400000001' }] }] } } }) };
  };
  const options = { config, store, fetchImpl, clock: () => now, sleep: async ms => { now += ms; }, directory, evidenceFile };
  const research = new RenewalResearch(options);
  const arm = () => armRenewalResearch({ enabled, directory, clock: () => now });
  const stage = () => { const approval = arm(); return research.stage({ probeId: approval.probeId, refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 }); };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { research, options, directory, evidenceFile, store, calls, arm, stage };
}
test('renewal research cannot ingest a credential or call Vodafone before explicit arming', t => {
  const { research, calls } = fixture(t);
  assert.equal(research.status().armed, false);
  assert.throws(() => research.stage({ probeId: 'not-approved', refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 }), error => error.code === 'renewal_not_armed');
  assert.equal(calls.length, 0);
});
test('staging encrypts the credential and sends no grant until browser release is committed', t => {
  const { research, calls, directory, arm, stage } = fixture(t);
  const staged = stage();
  assert.equal(staged.state, 'awaiting_browser_release');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(staged).includes(ORIGINAL), false);
  for (const file of fs.readdirSync(directory)) assert.equal(fs.readFileSync(path.join(directory, file)).includes(Buffer.from(ORIGINAL)), false);
  assert.equal(fs.statSync(path.join(directory, 'vault.json')).mode & 0o777, 0o600);
  assert.throws(() => arm(), /already recorded/);
  assert.throws(() => research.commit({ probeId: staged.probeId, browserReleased: false }), error => error.code === 'renewal_interrupted');
});
test('two independent renewals wait for expiry, use no cookies or secret, rotate once each and verify API access', async t => {
  const { research, calls, stage, directory, evidenceFile } = fixture(t);
  const staged = stage();
  research.commit({ probeId: staged.probeId, browserReleased: true });
  await research.operation;
  const status = research.status();
  assert.equal(status.state, 'complete'); assert.equal(status.backendRenewalVerified, true);
  assert.equal(status.tokenRequestsStarted, 2); assert.equal(status.running, false);
  assert.ok(status.attempts.every(attempt => attempt.previousAccessTokenExpired && attempt.consumerApiRead && attempt.refreshTokenRotated));
  const posts = calls.filter(call => call.url === TOKEN_URL);
  assert.equal(posts.length, 2); assert.ok(posts[0].at > NOW + 300000); assert.ok(posts[1].at > posts[0].at + 300000);
  for (const post of posts) {
    const form = new URLSearchParams(post.options.body);
    assert.deepEqual([...form.keys()].sort(), ['client_id', 'grant_type', 'redirect_uri', 'refresh_token']);
    assert.equal(form.get('client_id'), CLIENT_ID); assert.equal(form.get('redirect_uri'), REDIRECT_URI);
    assert.equal(post.options.credentials, 'omit'); assert.equal(post.options.redirect, 'error');
    assert.equal(post.options.headers.authorization, undefined); assert.equal(post.options.headers.cookie, undefined);
  }
  assert.equal(new URLSearchParams(posts[1].options.body).get('refresh_token'), 'private-rotated-refresh-1');
  assert.equal(research.vault().refreshToken, 'private-rotated-refresh-2');
  const publicEvidence = fs.readFileSync(evidenceFile, 'utf8');
  for (const marker of [ORIGINAL, 'private-access-token', 'private-rotated-refresh']) assert.equal(publicEvidence.includes(marker), false);
  assert.equal(fs.readFileSync(path.join(directory, 'vault.json'), 'utf8').includes('private-rotated-refresh'), false);
  assert.throws(() => research.commit({ probeId: staged.probeId, browserReleased: true }), error => error.code === 'renewal_interrupted');
});
test('an invalid grant or uncertain network outcome stops without retrying', async t => {
  for (const failure of ['invalid_grant', 'timeout']) {
    await t.test(failure, async child => {
      const { research, calls, stage } = fixture(child, { failure });
      const staged = stage(); research.commit({ probeId: staged.probeId, browserReleased: true }); await research.operation;
      assert.equal(research.status().state, 'failed');
      assert.equal(research.status().retryAttempted, false);
      assert.equal(calls.filter(call => call.url === TOKEN_URL).length, 1);
      assert.equal(JSON.stringify(research.status()).includes('private-provider'), false);
    });
  }
});
test('a rotated token is retained when API verification fails and a restarted process never resumes grants', async t => {
  const { research, options, stage, calls } = fixture(t, { apiFailure: true });
  const staged = stage(); research.commit({ probeId: staged.probeId, browserReleased: true }); await research.operation;
  assert.equal(research.status().state, 'failed');
  assert.equal(research.vault().refreshToken, 'private-rotated-refresh-1');
  assert.equal(calls.filter(call => call.url === TOKEN_URL).length, 1);
  const restarted = new RenewalResearch(options);
  assert.equal(restarted.status().state, 'failed');
  assert.equal(restarted.running, false);
});
test('stale browser tokens, replayed arms and interrupted ownership transfer are rejected', t => {
  const { research, options, arm, calls } = fixture(t);
  const approval = arm();
  assert.throws(() => research.stage({ probeId: approval.probeId, refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 1000 }), error => error.code === 'renewal_stale_page');
  const staged = research.stage({ probeId: approval.probeId, refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 });
  assert.throws(() => research.stage({ probeId: approval.probeId, refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 }), error => error.code === 'renewal_not_armed');
  const restarted = new RenewalResearch(options);
  assert.equal(restarted.status().state, 'interrupted_review_required');
  assert.throws(() => restarted.commit({ probeId: staged.probeId, browserReleased: true }), error => error.code === 'renewal_interrupted');
  assert.equal(calls.length, 0);
  assert.equal(research.abort(staged.probeId).state, 'aborted');
});
test('research HTTP endpoints require the backend session, exact origins and explicit arming', async t => {
  const { research, options, store, arm, calls } = fixture(t);
  const server = createApplication({ config: options.config, store, auth: {}, research });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = '/v1/research/vodafone/renewal-probe';
  const request = (route = '', { body, token = options.config.apiToken, headers = {}, ...rest } = {}) => fetch(origin + base + route, { ...rest, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request('', { token: null })).status, 401);
  assert.equal((await request('', { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await (await request()).json()).armed, false);
  const input = { probeId: 'unapproved', refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 };
  assert.equal((await request('/stage', { method: 'POST', body: input })).status, 409);
  input.probeId = arm().probeId;
  const staged = await request('/stage', { method: 'POST', body: input });
  assert.equal(staged.status, 200); assert.equal((await staged.text()).includes(ORIGINAL), false);
  assert.equal((await request('/commit', { method: 'POST', body: { probeId: input.probeId, browserReleased: false } })).status, 409);
  assert.equal((await request('/abort', { method: 'POST', body: { probeId: input.probeId } })).status, 200);
  assert.equal(calls.length, 0);
});

test('research is disabled by default even with an old arm and matching loopback origin', async t => {
  const { research, arm, options, store, calls, directory } = fixture(t, { enabled: false });
  fs.writeFileSync(path.join(directory, 'arm.json'), JSON.stringify({ probeId: 'old-arm', expiresAt: NOW + 600000, maxTokenRequests: 2 }));
  assert.equal(research.status().state, 'disabled');
  assert.throws(() => arm(), /disabled/);
  assert.throws(() => research.stage({ probeId: 'old-arm', refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 }), error => error.code === 'renewal_not_armed');
  assert.throws(() => research.commit({ probeId: 'old-arm', browserReleased: true }), error => error.code === 'research_disabled');
  const server = createApplication({ config: options.config, store, auth: {}, research });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/research/vodafone/renewal-probe`, { headers: { authorization: `Bearer ${options.config.apiToken}` } });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test('research opt-in cannot enable a listener bound to all interfaces', t => {
  const { research, options, calls } = fixture(t);
  options.config.host = '0.0.0.0';
  assert.equal(research.status().state, 'disabled');
  assert.throws(() => research.stage({ probeId: 'not-approved', refreshToken: ORIGINAL, accessTokenExpiresAt: NOW + 300000 }), error => error.code === 'renewal_not_armed');
  assert.equal(calls.length, 0);
});
