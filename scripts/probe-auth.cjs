'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ISSUER = 'https://authn.vodafone.com.au/';
const registrationCheck = process.argv.includes('--registration-check');
const dryRun = process.argv.includes('--dry-run');
const destination = path.join(__dirname, '../docs/evidence/vodafone-auth.json');
const previous = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : null;
const request = { method: 'POST', url: new URL('oidc/register', ISSUER).toString(), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: {} };
if (dryRun) {
  console.log(JSON.stringify({ discovery: { method: 'GET', url: new URL('.well-known/openid-configuration', ISSUER).toString() }, registration: registrationCheck ? request : 'Not requested' }, null, 2));
  process.exit(0);
}
(async () => {
  if (registrationCheck && previous?.registration?.checked) throw new Error('The one approved empty registration probe is already recorded. No repeat request was sent.');
  const response = await fetch(new URL('.well-known/openid-configuration', ISSUER), { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Discovery returned HTTP ${response.status}.`);
  const data = await response.json();
  if (data.issuer !== ISSUER || new URL(data.token_endpoint).origin !== new URL(ISSUER).origin || new URL(data.authorization_endpoint).origin !== new URL(ISSUER).origin) throw new Error('Unexpected Vodafone issuer or endpoints.');
  const evidence = {
    observedAt: new Date().toISOString(),
    source: new URL('.well-known/openid-configuration', ISSUER).toString(),
    discovery: { status: response.status, issuer: data.issuer, authorizationEndpoint: data.authorization_endpoint, tokenEndpoint: data.token_endpoint, registrationEndpoint: data.registration_endpoint || null, authorizationCode: data.grant_types_supported?.includes('authorization_code') || false, refreshToken: data.grant_types_supported?.includes('refresh_token') || false, pkceS256: data.code_challenge_methods_supported?.includes('S256') || false, tokenAuthMethods: data.token_endpoint_auth_methods_supported || [] },
    registration: previous?.registration || { checked: false, status: 'unknown', reason: 'Discovery alone cannot prove registration or API grants.' },
    liveAuthorization: previous?.liveAuthorization || { completed: false, refreshVerified: false, apiCallVerified: false, reason: 'Live sign-in, consumer API access and refresh have not been verified.' }
  };
  if (registrationCheck) {
    // This flag is only for an explicitly approved registration probe. Do not
    // retry a rejected probe with another tool or with alternate metadata.
    const result = await fetch(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(request.body), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const body = await result.json().catch(() => ({}));
    const error = typeof body.error === 'string' ? body.error.slice(0, 150) : null;
    const description = typeof (body.error_description || body.message) === 'string' ? (body.error_description || body.message).slice(0, 400) : null;
    evidence.registration = { checked: true, method: 'POST', path: '/oidc/register', metadata: 'Empty object; redirect_uris omitted', httpStatus: result.status, error, description, unexpectedClientCreated: !!body.client_id, status: /disabled|not.enabled/i.test(`${error} ${description}`) ? 'disabled' : 'unproven', reason: 'A validation response is not proof that a valid client can be registered or granted the consumer API.' };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
})().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
