'use strict';
const fs = require('node:fs');
const path = require('node:path');
const URL = 'https://authn.vodafone.com.au/oidc/register';
const REVIEWED = {
  client_name: 'VodaLens Local Development',
  redirect_uris: ['http://127.0.0.1:8766/oauth/vodafone/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code']
};
function plan(root) {
  return { method: 'POST', url: URL, body: JSON.parse(fs.readFileSync(path.join(root, 'docs/auth/vodalens-development-client.json'), 'utf8')), effects: 'If allowed, creates ONE public development OAuth client in Vodafone’s Auth0 tenant. It does not itself grant the consumer API.', executed: false };
}
async function registerDevelopmentClient({ root, fetchImpl = fetch }) {
  const request = plan(root);
  if (JSON.stringify(request.body) !== JSON.stringify(REVIEWED)) throw new Error('The reviewed registration metadata changed. Obtain new approval.');
  const destination = path.join(root, 'docs/evidence/client-registration.json');
  const attempt = path.join(root, 'docs/evidence/client-registration-attempt.json');
  const envPath = path.join(root, '.env');
  const env = fs.readFileSync(envPath, 'utf8');
  if (!/^VODAFONE_CLIENT_ID=$/m.test(env) || /^VODAFONE_CLIENT_ID=.+$/m.test(env)) throw new Error('Registration requires one empty VODAFONE_CLIENT_ID entry in the existing .env. No request was sent.');
  if (fs.existsSync(destination) || fs.existsSync(attempt)) throw new Error('A registration attempt is already recorded. Refusing another POST; review the existing outcome first.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Persist intent before the external mutation. A timeout must never trigger
  // an automatic retry, because the provider might have created the client.
  fs.writeFileSync(attempt, JSON.stringify({ attemptedAt: new Date().toISOString(), target: URL, requestedMetadata: request.body, outcome: 'pending_or_unknown', retryAllowed: false }, null, 2) + '\n', { flag: 'wx' });
  const evidence = { observedAt: new Date().toISOString(), target: URL, requestedMetadata: request.body, httpStatus: null, created: false, clientId: null, apiGrantVerified: false, authorizationCodeVerified: false, refreshVerified: false };
  try {
    const response = await fetchImpl(URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request.body), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    Object.assign(evidence, {
      httpStatus: response.status,
      created: response.ok && typeof data.client_id === 'string',
      clientId: typeof data.client_id === 'string' ? data.client_id : null,
      outcome: response.ok && typeof data.client_id === 'string' ? 'created' : response.ok ? 'unexpected_response_review_before_retry' : 'rejected',
      error: typeof data.error === 'string' ? data.error.slice(0, 150) : null,
      description: typeof (data.error_description || data.message) === 'string' ? (data.error_description || data.message).slice(0, 500) : null
    });
    // Retain the public result before optional local setup can fail.
    fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    if (evidence.created) {
      if (data.client_secret) {
        fs.mkdirSync(path.join(root, 'local-data'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(root, 'local-data/unexpected-registration-secret.json'), JSON.stringify({ client_id: data.client_id, client_secret: data.client_secret }), { mode: 0o600, flag: 'wx' });
        evidence.unexpectedSecretStoredPrivately = true;
      }
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(data.client_id)) throw new Error('Unexpected client-ID format.');
      if (fs.readFileSync(envPath, 'utf8') !== env) throw new Error('Local configuration changed during registration.');
      fs.writeFileSync(envPath, env.replace(/^VODAFONE_CLIENT_ID=$/m, `VODAFONE_CLIENT_ID=${data.client_id}`), { mode: 0o600 });
      fs.chmodSync(envPath, 0o600);
      evidence.localClientConfigured = true;
    }
  } catch (error) {
    evidence.outcome ||= 'unknown_review_before_retry';
    evidence.localSetupFailed = evidence.created;
    fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
    throw new Error(evidence.created ? 'A client was created, but local setup needs review. Its public ID is retained in docs/evidence/client-registration.json. Do not repeat the registration.' : 'Registration did not complete reliably. Review docs/evidence/client-registration.json before any further request; no retry was made.');
  }
  fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
if (require.main === module) {
  const root = path.join(__dirname, '..');
  if (!process.argv.includes('--execute')) console.log(JSON.stringify(plan(root), null, 2));
  else registerDevelopmentClient({ root }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { plan, registerDevelopmentClient };
