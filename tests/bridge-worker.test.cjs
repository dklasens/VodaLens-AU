'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../apps/edge/session-bridge/background.js'), 'utf8');
function worker({ failureCode, failureMessage = 'private-error-marker', sessionState = 'sign_in_required', researchArmed = false, retireSuccess = true } = {}) {
  let listener; const data = {}, calls = [];
  class Client {
    constructor(config) { assert.equal(config.getSessionToken(), 'private-backend-credential'); }
    async capabilities() { calls.push('capabilities'); if (failureCode) { const error = new Error(failureMessage); error.code = failureCode; throw error; } return {}; }
    async authStatus() { calls.push('status'); return { state: sessionState, connected: sessionState === 'connected' }; }
    async connectMyVodafone(token) { calls.push({ token }); return { connected: true, proof: { consumerApiRead: true } }; }
    async verifySession() { calls.push('verify'); return { connected: true }; }
    async disconnectVodafone() { calls.push('disconnect'); return { connected: false }; }
    async request(route, options = {}) { calls.push({ researchRoute: route }); return options.method ? { ok: true } : { armed: researchArmed, probeId: 'approved-probe' }; }
  }
  const extension = { id: 'trusted-extension', url: 'chrome-extension://trusted-extension/popup.html' };
  const page = { id: 'trusted-extension', url: 'https://my.vodafone.com.au/', frameId: 0, tab: { id: 7 } };
  const context = vm.createContext({
    URL, Date, importScripts() {}, VodaLensClient: Client,
    fetch: async () => ({ ok: true, json: async () => ({ backendOrigin: 'http://127.0.0.1:8766', backendToken: 'private-backend-credential' }) }),
    chrome: {
      runtime: { id: 'trusted-extension', getURL: file => `chrome-extension://trusted-extension/${file}`, onMessage: { addListener: fn => { listener = fn; } } },
      storage: { session: { get: async () => data, set: async value => Object.assign(data, value) } },
      tabs: { query: async () => [{ id: 7, url: 'https://my.vodafone.com.au/' }], reload: async id => calls.push({ reload: id }), update: async (id, options) => calls.push({ navigate: options.url }), sendMessage: async (id, message, options) => { assert.equal(options.frameId, 0); calls.push({ researchRelay: message.type }); return message.type === 'prepareRenewalResearch' ? { refreshToken: 'private-research-refresh-credential', accessTokenExpiresAt: Date.now() + 300000 } : { retired: retireSuccess }; } }
    }
  });
  vm.runInContext(script, context);
  const message = (body, sender = extension) => new Promise(resolve => { if (listener(body, sender, resolve) !== true) resolve(undefined); });
  return { message, extension, page, data, calls };
}
const observed = { type: 'observedSession', accessToken: 'private-vodafone-access-token' };
test('session bridge ignores unarmed capture and page attempts to arm itself', async () => {
  const { message, page, calls } = worker();
  await message(observed, page); await message({ type: 'connect' }, page);
  assert.equal(calls.length, 0);
});
test('session bridge accepts only its armed top-level My Vodafone tab', async () => {
  const { message, page, calls, data } = worker();
  await message({ type: 'connect' });
  assert.equal(data.bridge.armed, true);
  for (const sender of [{ ...page, id: 'other-extension' }, { ...page, url: 'https://other.example/' }, { ...page, frameId: 1 }, { ...page, tab: { id: 8 } }]) await message(observed, sender);
  assert.equal(calls.some(call => call.token), false);
  await message(observed, page);
  assert.equal(calls.filter(call => call.token).length, 1);
  assert.equal(data.bridge.armed, false);
  assert.equal(JSON.stringify(data).includes(observed.accessToken), false);
  assert.equal(JSON.stringify(data).includes('private-backend-credential'), false);
  await message(observed, page);
  assert.equal(calls.filter(call => call.token).length, 1);
});
test('session bridge refuses an expired arm', async () => {
  const { message, page, data, calls } = worker();
  await message({ type: 'connect' }); data.bridge.until = Date.now() - 1;
  await message(observed, page);
  assert.equal(calls.some(call => call.token), false);
});
test('session bridge reports an actionable backend error without copying private exception text', async () => {
  const { message } = worker({ failureCode: 'backend_unreachable' });
  const result = await message({ type: 'connect' });
  assert.match(result.error, /Cannot reach the local VodaLens backend/);
  assert.equal(result.error.includes('private-error-marker'), false);
  const unexpected = await worker({ failureCode: 'unknown_failure' }).message({ type: 'connect' });
  assert.equal(unexpected.error.includes('private-error-marker'), false);
});
test('opening the popup refreshes backend status instead of trusting a cached connected message', async () => {
  const { message, data, calls } = worker({ sessionState: 'reconnect_required' });
  data.bridge = { armed: false, message: 'Connected.', status: { connected: true } };
  const state = await message({ type: 'state' });
  assert.equal(state.status.connected, false);
  assert.match(state.message, /session has expired/);
  assert.equal(calls.filter(call => call === 'status').length, 1);
});
test('research cannot read a refresh credential unless the backend is explicitly armed', async () => {
  const { message, page, calls } = worker();
  await message({ type: 'testBackendRenewal' }, page);
  assert.equal(calls.length, 0);
  const result = await message({ type: 'testBackendRenewal' });
  assert.match(result.error, /not armed/);
  assert.equal(calls.some(call => call.researchRelay), false);
});
test('research stages securely, retires the browser copy and leaves Vodafone before committing grants', async () => {
  const { message, calls, data } = worker({ researchArmed: true });
  const result = await message({ type: 'testBackendRenewal' });
  assert.equal(result.ok, true);
  const sequence = calls.map(call => call.researchRoute?.split('/').at(-1) || call.researchRelay || (call.navigate ? 'navigate' : null)).filter(Boolean);
  assert.deepEqual(sequence, ['renewal-probe', 'prepareRenewalResearch', 'stage', 'retireRenewalCredential', 'navigate', 'commit']);
  assert.equal(JSON.stringify(data).includes('private-research-refresh-credential'), false);
});
test('research aborts without committing if the browser cache changed before retirement', async () => {
  const { message, calls } = worker({ researchArmed: true, retireSuccess: false });
  const result = await message({ type: 'testBackendRenewal' });
  assert.ok(result.error);
  assert.equal(calls.some(call => call.researchRoute?.endsWith('/commit')), false);
  assert.equal(calls.some(call => call.researchRoute?.endsWith('/abort')), true);
});
