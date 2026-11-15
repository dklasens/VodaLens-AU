'use strict';
const path = require('node:path');
const ISSUER = 'https://authn.vodafone.com.au/';
const AUDIENCE = 'https://dsapi.vodafone.com.au';
const STREAMS = Object.freeze(['edge', 'ios', 'android']);
function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const origin = new URL(env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('PUBLIC_ORIGIN must be HTTPS or a loopback development origin, without a path.');
  const apiToken = env.VODALENS_API_TOKEN || '';
  if (Buffer.byteLength(apiToken) < 32 || /\s/.test(apiToken)) throw new Error('Set VODALENS_API_TOKEN to a random value of at least 32 characters.');
  const keyText = env.VODALENS_VAULT_KEY || '';
  const vaultKey = Buffer.from(keyText, 'base64');
  if (vaultKey.length !== 32 || vaultKey.toString('base64') !== keyText) throw new Error('Set VODALENS_VAULT_KEY to a base64-encoded 32-byte encryption key.');
  const clientId = (env.VODAFONE_CLIENT_ID || '').trim();
  const authMethod = env.VODAFONE_AUTH_METHOD || 'myvodafone-session';
  if (!['myvodafone-session', 'registered-oauth'].includes(authMethod)) throw new Error('VODAFONE_AUTH_METHOD must be myvodafone-session or registered-oauth.');
  const tokenAuthMethod = env.VODAFONE_TOKEN_AUTH_METHOD || 'none';
  if (!['none', 'client_secret_basic'].includes(tokenAuthMethod)) throw new Error('VODAFONE_TOKEN_AUTH_METHOD must be none or client_secret_basic.');
  const clientSecret = env.VODAFONE_CLIENT_SECRET || '';
  if (clientId && tokenAuthMethod === 'client_secret_basic' && !clientSecret) throw new Error('The registered confidential client requires VODAFONE_CLIENT_SECRET.');
  return {
    host: env.HOST || '127.0.0.1', port, publicOrigin: origin.origin,
    redirectUri: new URL('/oauth/vodafone/callback', origin).toString(),
    issuer: ISSUER, audience: AUDIENCE, clientId, clientSecret, tokenAuthMethod, authMethod,
    scope: 'openid profile email offline_access',
    apiToken, vaultKey, ownerId: env.VODALENS_OWNER_ID || 'personal-owner',
    database: path.resolve(env.DATABASE_PATH || '.data/vodalens.sqlite'),
    allowedOrigins: (env.ALLOWED_CLIENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    streams: STREAMS
  };
}
module.exports = { loadConfig, ISSUER, AUDIENCE, STREAMS };
