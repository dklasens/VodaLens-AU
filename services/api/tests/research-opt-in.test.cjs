'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { loadConfig } = require('../src/config.cjs');
const config = extra => loadConfig({ VODALENS_API_TOKEN: 'test-development-backend-session-token', VODALENS_VAULT_KEY: randomBytes(32).toString('base64'), ...extra });
test('browser renewal research defaults off and only the explicit true setting enables it', () => {
  assert.equal(config({}).renewalResearchEnabled, false);
  assert.equal(config({ VODALENS_ENABLE_RENEWAL_RESEARCH: 'false' }).renewalResearchEnabled, false);
  assert.equal(config({ VODALENS_ENABLE_RENEWAL_RESEARCH: 'true' }).renewalResearchEnabled, true);
  for (const value of ['1', 'TRUE', 'yes']) assert.throws(() => config({ VODALENS_ENABLE_RENEWAL_RESEARCH: value }), /must be true or false/);
});
