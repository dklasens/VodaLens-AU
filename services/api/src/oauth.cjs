'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { VodafoneClient } = require('../../../packages/vodafone-client/src/index.cjs');
const { hasAccountData } = require('./account.cjs');
class AuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');
class VodafoneAuth {
  constructor({ config, store, fetchImpl = fetch, clock = Date.now }) {
    this.config = config; this.store = store; this.fetchImpl = fetchImpl; this.clock = clock; this.refreshes = new Map();
  }
  status(ownerId) {
    const proof = this.store.proof(ownerId);
    return { provider: 'vodafone-au', registration: proof?.authorizationCode ? 'authorization_verified' : this.config.clientId ? 'configured_unverified' : 'required', callbackUrl: this.config.redirectUri, connected: !!proof, proof: proof || { authorizationCode: false, consumerApiRead: false, refreshAndApiRead: false }, allGatesPassed: !!(proof?.authorizationCode && proof?.consumerApiRead && proof?.refreshAndApiRead) };
  }
  start(ownerId, stream) {
    if (!this.config.clientId) throw new AuthError('registration_required', 'A VodaLens OAuth client must be registered with Vodafone first.', 503);
    if (!this.config.streams.includes(stream)) throw new AuthError('invalid_stream', 'Choose edge, ios or android.');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    this.store.saveTransaction({ state, ownerId, stream, verifier, expiresAt: this.clock() + 600000 });
    const url = new URL('authorize', this.config.issuer);
    Object.entries({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', audience: this.config.audience, scope: this.config.scope, state, code_challenge: challenge(verifier), code_challenge_method: 'S256' }).forEach(([k, v]) => url.searchParams.set(k, v));
    return { authorizationUrl: url.toString(), expiresIn: 600, stream };
  }
  async tokenRequest(parameters) {
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const body = new URLSearchParams({ client_id: this.config.clientId, ...parameters });
    if (this.config.tokenAuthMethod === 'client_secret_basic') {
      headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64');
      body.delete('client_id');
    }
    let response;
    try { response = await this.fetchImpl(new URL('oauth/token', this.config.issuer).toString(), { method: 'POST', headers, body: body.toString(), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) }); }
    catch { throw new AuthError('provider_unavailable', 'Vodafone sign-in could not be reached.', 502); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AuthError(data.error === 'invalid_grant' ? 'reauthentication_required' : 'provider_token_rejected', 'Vodafone did not accept the authorization grant.', 502);
    if (typeof data.access_token !== 'string' || !data.access_token || /\s/.test(data.access_token) || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || !Number.isSafeInteger(this.clock() + data.expires_in * 1000)) throw new AuthError('invalid_token_response', 'Vodafone returned an invalid token response.', 502);
    return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null, expiresAt: this.clock() + data.expires_in * 1000 };
  }
  client(getAccessToken) { return new VodafoneClient({ getAccessToken, fetchImpl: this.fetchImpl }); }
  async verifyApi(accessToken) {
    const result = await this.client(async () => accessToken).plans();
    if (!hasAccountData(result)) throw new AuthError('unexpected_api_response', 'The consumer API did not return nonempty account data in the expected envelope.', 502);
  }
  async callback({ state, code, error }) {
    if (!state || typeof state !== 'string' || state.length > 256) throw new AuthError('invalid_state', 'The sign-in state is missing or invalid.');
    const transaction = this.store.consumeTransaction(state);
    if (!transaction) throw new AuthError('invalid_state', 'The sign-in link expired or has already been used.');
    if (error) throw new AuthError('authorization_denied', 'Vodafone authorization was not granted.');
    if (!code || typeof code !== 'string' || code.length > 8192) throw new AuthError('invalid_code', 'The sign-in code is missing or invalid.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: transaction.verifier, redirect_uri: this.config.redirectUri });
    await this.verifyApi(tokens.accessToken);
    this.store.saveConnection(transaction.ownerId, tokens, { authorizationCode: true, consumerApiRead: true, refreshAndApiRead: false, hasRefreshToken: !!tokens.refreshToken, connectedAt: this.clock() });
    return { stream: transaction.stream, connected: true };
  }
  async accessToken(ownerId, { forceRefresh = false } = {}) {
    if (this.refreshes.has(ownerId)) return this.refreshes.get(ownerId);
    const connection = this.store.connection(ownerId);
    if (!connection) throw new AuthError('not_connected', 'Connect Vodafone before requesting live data.', 409);
    if (!forceRefresh && connection.tokens.expiresAt > this.clock() + 30000) return connection.tokens.accessToken;
    if (!connection.tokens.refreshToken) throw new AuthError('reauthentication_required', 'Vodafone did not issue a refresh token. Sign in again.', 409);
    const operation = (async () => {
      const tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: connection.tokens.refreshToken });
      tokens.refreshToken ||= connection.tokens.refreshToken;
      // Rotation can invalidate the previous refresh token immediately. Commit
      // the new token before testing API access so a transient API failure does
      // not lose the replacement refresh token.
      this.store.saveConnection(ownerId, tokens, { ...connection.proof, consumerApiRead: false, refreshAndApiRead: false, hasRefreshToken: !!tokens.refreshToken, refreshedAt: this.clock() });
      await this.verifyApi(tokens.accessToken);
      this.store.saveConnection(ownerId, tokens, { ...connection.proof, consumerApiRead: true, refreshAndApiRead: true, hasRefreshToken: !!tokens.refreshToken, refreshedAt: this.clock() });
      return tokens.accessToken;
    })();
    this.refreshes.set(ownerId, operation);
    try { return await operation; }
    catch (error) { if (error.code === 'reauthentication_required') this.store.removeConnection(ownerId); throw error; }
    finally { this.refreshes.delete(ownerId); }
  }
  providerClient(ownerId) { return this.client(options => this.accessToken(ownerId, options)); }
}
module.exports = { VodafoneAuth, AuthError, challenge };
