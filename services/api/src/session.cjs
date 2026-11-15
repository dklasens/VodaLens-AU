'use strict';
const { VodafoneClient } = require('../../../packages/vodafone-client/src/index.cjs');
const { AuthError } = require('./oauth.cjs');
const { createHash } = require('node:crypto');
const { hasAccountData } = require('./account.cjs');
const fingerprint = value => createHash('sha256').update(value).digest('hex');
// An exp claim only shortens the local lifetime. Acceptance is proven by an
// authenticated Vodafone API read, never by trusting an unsigned JWT decode.
function sessionExpiry(token, now) {
  let expiry = now + 10 * 60 * 1000;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (Number.isSafeInteger(claims.exp) && claims.exp > 0) expiry = Math.min(now + 24 * 60 * 60 * 1000, claims.exp * 1000);
  } catch { /* Opaque access tokens get a conservative ten-minute local TTL. */ }
  if (expiry <= now + 15000) throw new AuthError('session_expired', 'Refresh My Vodafone to obtain a current session.', 409);
  return expiry;
}
class MyVodafoneSession {
  constructor({ config, store, fetchImpl = fetch, clock = Date.now }) {
    this.config = config; this.store = store; this.fetchImpl = fetchImpl; this.clock = clock;
    this.method = 'myvodafone-session';
  }
  status(ownerId) {
    const connection = this.store.connection(ownerId);
    const current = connection?.proof?.method === this.method ? connection : null;
    const expired = !!current && current.tokens.expiresAt <= this.clock() + 15000;
    return {
      provider: 'vodafone-au', method: this.method, registrationRequired: false,
      connected: !!current && !expired,
      state: !current ? 'sign_in_required' : expired ? 'reconnect_required' : 'connected',
      expiresAt: current?.tokens.expiresAt || null,
      renewal: 'Refresh or sign in to My Vodafone, then reconnect the browser companion.',
      automaticRefreshSupported: false,
      proof: current?.proof || { method: this.method, consumerApiRead: false, sessionReplacementVerified: false },
      allGatesPassed: !!current && !expired && current.proof.consumerApiRead === true && current.proof.sessionReplacementVerified === true
    };
  }
  start(ownerId, stream) {
    if (!this.config.streams.includes(stream)) throw new AuthError('invalid_stream', 'Choose edge, ios or android.');
    return { method: this.method, loginUrl: 'https://my.vodafone.com.au/', stream, handoff: 'browser_session_bridge' };
  }
  async callback() { throw new AuthError('oauth_not_in_use', 'VodaLens uses your My Vodafone browser session.', 409); }
  client(getAccessToken) { return new VodafoneClient({ getAccessToken, fetchImpl: this.fetchImpl }); }
  async verifyApi(token) {
    const result = await this.client(async ({ forceRefresh } = {}) => {
      if (forceRefresh) throw new AuthError('session_rejected', 'My Vodafone rejected this access token. Refresh the website and reconnect.', 409);
      return token;
    }).plans({ signal: AbortSignal.timeout(15000) });
    if (!hasAccountData(result)) throw new AuthError('unexpected_api_response', 'The Vodafone session did not return nonempty account data in the expected envelope.', 502);
  }
  async importSession(ownerId, input) {
    if (input.source !== 'myvodafone-browser' || typeof input.accessToken !== 'string' || input.accessToken.length < 16 || input.accessToken.length > 12000 || /\s/.test(input.accessToken)) throw new AuthError('invalid_session', 'Supply an access token observed on an authenticated My Vodafone API request.');
    // Refresh tokens and cookies belong to My Vodafone's login lifecycle. This
    // bridge accepts only a short-lived access token, never those credentials.
    if (Object.hasOwn(input, 'refreshToken') || Object.hasOwn(input, 'cookies')) throw new AuthError('unsupported_credentials', 'Only a My Vodafone access token is accepted.');
    const expiresAt = sessionExpiry(input.accessToken, this.clock());
    await this.verifyApi(input.accessToken);
    const previous = this.store.connection(ownerId);
    const previousFingerprint = previous?.tokens?.accessToken ? fingerprint(previous.tokens.accessToken) : previous?.tokens?.previousAccessTokenHash;
    const replaced = previous?.proof?.method === this.method && previousFingerprint && previousFingerprint !== fingerprint(input.accessToken);
    this.store.saveConnection(ownerId, { accessToken: input.accessToken, refreshToken: null, expiresAt }, {
      method: this.method, consumerApiRead: true,
      sessionReplacementVerified: !!(replaced || previous?.proof?.sessionReplacementVerified),
      connectedAt: previous?.proof?.connectedAt || this.clock(), lastVerifiedAt: this.clock()
    });
    return this.status(ownerId);
  }
  async verify(ownerId) {
    const token = await this.accessToken(ownerId);
    try { await this.verifyApi(token); }
    catch (error) {
      if (error.code === 'session_rejected') {
        const current = this.store.connection(ownerId);
        if (current?.tokens.accessToken === token) this.invalidate(ownerId, current);
        throw new AuthError('reconnect_required', 'My Vodafone no longer accepts this session. Sign in again and reconnect.', 409);
      }
      throw error;
    }
    const current = this.store.connection(ownerId);
    this.store.saveConnection(ownerId, current.tokens, { ...current.proof, consumerApiRead: true, lastVerifiedAt: this.clock() });
    return this.status(ownerId);
  }
  invalidate(ownerId, connection) {
    const previousAccessTokenHash = connection.tokens.accessToken ? fingerprint(connection.tokens.accessToken) : connection.tokens.previousAccessTokenHash;
    this.store.saveConnection(ownerId, { accessToken: null, refreshToken: null, expiresAt: this.clock(), previousAccessTokenHash }, { ...connection.proof, reconnectRequired: true });
  }
  async accessToken(ownerId, { forceRefresh = false, rejectedToken } = {}) {
    const current = this.store.connection(ownerId);
    if (!current || current.proof.method !== this.method) throw new AuthError('not_connected', 'Sign in to My Vodafone and connect the browser companion.', 409);
    // An older in-flight request may receive a 401 after a fresh handoff. It
    // must not invalidate the replacement that has already been verified.
    if (forceRefresh && rejectedToken && current.tokens.accessToken && current.tokens.accessToken !== rejectedToken && current.tokens.expiresAt > this.clock() + 15000) return current.tokens.accessToken;
    if (forceRefresh || current.tokens.expiresAt <= this.clock() + 15000 || !current.tokens.accessToken) {
      this.invalidate(ownerId, current);
      throw new AuthError('reconnect_required', 'Reconnect from My Vodafone. This browser session cannot be refreshed independently by VodaLens.', 409);
    }
    return current.tokens.accessToken;
  }
  disconnect(ownerId) { this.store.removeConnection(ownerId); return this.status(ownerId); }
  providerClient(ownerId) { return this.client(options => this.accessToken(ownerId, options)); }
}
module.exports = { MyVodafoneSession, sessionExpiry };
