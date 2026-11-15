'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { VodaLensClient } = require('../packages/backend-client/src/index.cjs');
test('default browser fetch keeps its WorkerGlobalScope receiver', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../packages/backend-client/src/index.cjs'), 'utf8');
  const realm = { URL, AbortSignal };
  let actualReceiver;
  realm.fetch = function () { actualReceiver = this; return Promise.resolve({ ok: true, json: async () => ({ connected: true }) }); };
  const context = vm.createContext(realm);
  vm.runInContext(source, context);
  const expectedReceiver = vm.runInContext('globalThis', context);
  const client = new realm.VodaLensClient({ baseUrl: 'http://127.0.0.1:8766', getSessionToken: () => 'private-backend-token' });
  assert.equal((await client.authStatus()).connected, true);
  assert.equal(actualReceiver, expectedReceiver);
});
test('backend client distinguishes network and timeout failures without exposing raw errors', async () => {
  for (const [name, code] of [['TypeError', 'backend_unreachable'], ['TimeoutError', 'backend_timeout']]) {
    const client = new VodaLensClient({ baseUrl: 'http://127.0.0.1:8766', getSessionToken: () => 'private-backend-token', fetchImpl: async () => { const error = new Error('private-error-marker'); error.name = name; throw error; } });
    await assert.rejects(client.authStatus(), error => error.code === code && !error.message.includes('private-error-marker'));
  }
});
