'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { registerDevelopmentClient } = require('../scripts/register-development-client.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vodalens-registration-'));
  fs.mkdirSync(path.join(root, 'docs/auth'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../docs/auth/vodalens-development-client.json'), path.join(root, 'docs/auth/vodalens-development-client.json'));
  fs.writeFileSync(path.join(root, '.env'), 'VODAFONE_CLIENT_ID=\nLOCAL_SECRET=do-not-print\n', { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('registration sends exactly the reviewed request and prevents duplicate creation', async t => {
  const root = fixture(t); let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://authn.vodafone.com.au/oidc/register');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.deepEqual(JSON.parse(options.body), JSON.parse(fs.readFileSync(path.join(root, 'docs/auth/vodalens-development-client.json'))));
    assert.equal(fs.existsSync(path.join(root, 'docs/evidence/client-registration-attempt.json')), true);
    return { ok: true, status: 201, json: async () => ({ client_id: 'tpc_test_client', client_secret: 'unexpected-private-secret' }) };
  };
  const evidence = await registerDevelopmentClient({ root, fetchImpl });
  assert.equal(evidence.created, true); assert.equal(evidence.apiGrantVerified, false);
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /^VODAFONE_CLIENT_ID=tpc_test_client$/m);
  const publicEvidence = fs.readFileSync(path.join(root, 'docs/evidence/client-registration.json'), 'utf8');
  assert.equal(publicEvidence.includes('unexpected-private-secret'), false);
  assert.equal(fs.statSync(path.join(root, 'local-data/unexpected-registration-secret.json')).mode & 0o777, 0o600);
  await assert.rejects(registerDevelopmentClient({ root, fetchImpl }));
  assert.equal(calls, 1);
});
test('uncertain registration outcome is retained and never retried automatically', async t => {
  const root = fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Simulated network timeout'); };
  await assert.rejects(registerDevelopmentClient({ root, fetchImpl }), /no retry was made/);
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/client-registration.json')));
  assert.equal(evidence.outcome, 'unknown_review_before_retry');
  await assert.rejects(registerDevelopmentClient({ root, fetchImpl }), /already recorded/);
  assert.equal(calls, 1);
});
test('registration rejects changed metadata and preconfigured clients before making a request', async t => {
  const root = fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error(); };
  fs.writeFileSync(path.join(root, '.env'), 'VODAFONE_CLIENT_ID=already-registered\n');
  await assert.rejects(registerDevelopmentClient({ root, fetchImpl }), /No request was sent/);
  fs.writeFileSync(path.join(root, '.env'), 'VODAFONE_CLIENT_ID=\n');
  fs.writeFileSync(path.join(root, 'docs/auth/vodalens-development-client.json'), JSON.stringify({ redirect_uris: ['https://other.example/callback'] }));
  await assert.rejects(registerDevelopmentClient({ root, fetchImpl }), /metadata changed/);
  assert.equal(calls, 0);
});
