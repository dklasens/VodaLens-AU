'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const A = require('../../../packages/vodafone-client/src/index.cjs');
const { hasAccountData } = require('./account.cjs');
const { AuthError } = require('./oauth.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const DIRECTORY = path.join(ROOT, 'local-data/renewal-research');
const EVIDENCE = path.join(DIRECTORY, 'evidence.json');
const CLIENT_ID = 'TE6munQ7o6txJRqZeSzLBzDECX1yVBJO';
const TOKEN_URL = 'https://authn.vodafone.com.au/oauth/token';
const REDIRECT_URI = 'https://my.vodafone.com.au';
const terminal = state => ['complete', 'failed', 'aborted'].includes(state);
function armRenewalResearch({ enabled = false, directory = DIRECTORY, clock = Date.now } = {}) {
  if (enabled !== true) throw new Error('Renewal research is disabled. Explicitly opt in before arming an experiment.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (['arm.json', 'arm-used.json', 'state.json', 'vault.json'].some(file => fs.existsSync(path.join(directory, file)))) throw new Error('A renewal experiment is already recorded. Review it before authorizing another.');
  const arm = { probeId: randomUUID(), expiresAt: clock() + 600000, maxTokenRequests: 2 };
  fs.writeFileSync(path.join(directory, 'arm.json'), JSON.stringify(arm), { flag: 'wx', mode: 0o600 });
  return arm;
}
class RenewalResearch {
  constructor({ config, store, fetchImpl = fetch, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), directory = DIRECTORY, evidenceFile = EVIDENCE }) {
    this.config = config; this.store = store; this.fetchImpl = fetchImpl; this.clock = clock; this.sleep = sleep; this.directory = directory; this.evidenceFile = evidenceFile;
    this.current = null; this.running = false; this.operation = null;
  }
  file(name) { return path.join(this.directory, name + '.json'); }
  read(name) { return fs.existsSync(this.file(name)) ? JSON.parse(fs.readFileSync(this.file(name), 'utf8')) : null; }
  enabled() { return this.config.renewalResearchEnabled === true && ['127.0.0.1', '::1', 'localhost'].includes(this.config.host || '127.0.0.1') && this.config.publicOrigin === 'http://127.0.0.1:8766' && this.config.authMethod === 'myvodafone-session'; }
  status() {
    if (!this.enabled()) return { armed: false, state: 'disabled', running: false };
    const arm = this.read('arm');
    if (arm && arm.expiresAt > this.clock()) return { ...arm, armed: true, state: 'armed', running: false };
    const state = this.current || this.read('state');
    if (!state) return { armed: false, state: 'not_armed', running: false };
    if (!this.current && !terminal(state.state)) return { ...state, armed: false, state: 'interrupted_review_required', running: false };
    return { ...state, armed: false, running: this.running };
  }
  record(patch) {
    this.current = { ...this.current, ...patch, updatedAt: this.clock() };
    fs.writeFileSync(this.file('state'), JSON.stringify(this.current, null, 2) + '\n', { mode: 0o600 });
    fs.mkdirSync(path.dirname(this.evidenceFile), { recursive: true });
    fs.writeFileSync(this.evidenceFile, JSON.stringify(this.current, null, 2) + '\n');
  }
  writeVault(value) {
    const sealed = this.store.seal(value, `renewal-research:${this.config.ownerId}:${this.current.probeId}`);
    const temporary = this.file('vault') + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ ciphertext: sealed }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, this.file('vault'));
  }
  vault() { return this.store.open(this.read('vault').ciphertext, `renewal-research:${this.config.ownerId}:${this.current.probeId}`); }
  stage(input) {
    const arm = this.read('arm');
    if (!this.enabled() || !arm || arm.expiresAt <= this.clock() || arm.probeId !== input.probeId) throw new AuthError('renewal_not_armed', 'This experiment needs a fresh, explicitly approved one-time arm.', 409);
    if (typeof input.refreshToken !== 'string' || input.refreshToken.length < 16 || input.refreshToken.length > 8192 || /\s/.test(input.refreshToken)) throw new AuthError('invalid_refresh_credential', 'The approved browser refresh credential is invalid.');
    if (!Number.isSafeInteger(input.accessTokenExpiresAt) || input.accessTokenExpiresAt < this.clock() + 90000 || input.accessTokenExpiresAt > this.clock() + 360000) throw new AuthError('renewal_stale_page', 'Refresh My Vodafone normally, then start the experiment while its token is fresh.', 409);
    fs.renameSync(this.file('arm'), this.file('arm-used'));
    this.current = { probeId: arm.probeId, state: 'awaiting_browser_release', startedAt: this.clock(), commitDeadlineAt: this.clock() + 60000, initialAccessTokenExpiresAt: input.accessTokenExpiresAt, maxTokenRequests: 2, tokenRequestsStarted: 0, browserCredentialRetired: false, cookiesSent: false, clientSecretUsed: false, clientId: CLIENT_ID, tokenEndpoint: TOKEN_URL, credentialsIncluded: false, attempts: [] };
    this.writeVault({ refreshToken: input.refreshToken, accessTokenExpiresAt: input.accessTokenExpiresAt });
    this.record({});
    return this.status();
  }
  abort(probeId) {
    if (!this.enabled()) throw new AuthError('research_disabled', 'Renewal research is disabled.', 404);
    if (!this.current || this.current.probeId !== probeId || this.current.state !== 'awaiting_browser_release') throw new AuthError('renewal_interrupted', 'This experiment cannot be cancelled automatically.', 409);
    fs.rmSync(this.file('vault'), { force: true });
    this.record({ state: 'aborted' });
    return this.status();
  }
  commit(input) {
    if (!this.enabled()) throw new AuthError('research_disabled', 'Renewal research is disabled.', 404);
    if (!this.current || this.current.probeId !== input.probeId || this.current.state !== 'awaiting_browser_release' || this.current.commitDeadlineAt <= this.clock() || input.browserReleased !== true) throw new AuthError('renewal_interrupted', 'The browser must release its credential promptly before the experiment can begin.', 409);
    this.running = true;
    this.record({ browserCredentialRetired: true, state: 'waiting_for_expiry', nextActionAt: this.vault().accessTokenExpiresAt + 1000 });
    this.operation = this.run().catch(error => {
      const phase = this.current.state;
      const safeCode = ['invalid_grant', 'access_denied', 'invalid_client', 'invalid_token_response', 'consumer_api_rejected', 'unexpected_account_response'].includes(error.code) ? error.code : phase === 'verifying_api' ? 'consumer_api_read_failed' : 'unknown_outcome_review_required';
      this.record({ state: 'failed', failurePhase: phase, failureCode: safeCode, httpStatus: Number.isInteger(error.status) ? error.status : null, retryAttempted: false });
    }).finally(() => { this.running = false; });
    return this.status();
  }
  async run() {
    for (let index = 0; index < 2; index++) {
      let vault = this.vault();
      const deadline = vault.accessTokenExpiresAt + 1000;
      this.record({ state: 'waiting_for_expiry', nextActionAt: deadline });
      await this.sleep(Math.max(0, deadline - this.clock()));
      this.record({ state: 'requesting_token', tokenRequestsStarted: index + 1, nextActionAt: null });
      const response = await this.fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: vault.refreshToken, redirect_uri: REDIRECT_URI }).toString(), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error('Refresh rejected'); error.code = data.error; error.status = response.status; throw error; }
      const replacement = typeof data.refresh_token === 'string' && data.refresh_token.length >= 16 && data.refresh_token.length <= 8192 && !/\s/.test(data.refresh_token) ? data.refresh_token : null;
      const accessValid = typeof data.access_token === 'string' && data.access_token.length >= 16 && data.access_token.length <= 12000 && !/\s/.test(data.access_token);
      const lifetimeValid = Number.isSafeInteger(data.expires_in) && data.expires_in > 0 && data.expires_in <= 360;
      const attempt = { index: index + 1, requestedAt: this.clock(), previousAccessTokenExpired: this.clock() > vault.accessTokenExpiresAt, tokenHttpStatus: response.status, expiresInSeconds: lifetimeValid ? data.expires_in : null, refreshTokenReturned: !!replacement, refreshTokenRotated: !!replacement && replacement !== vault.refreshToken, consumerApiRead: false };
      // Save the rotated credential before any API call can fail. Never retry a
      // grant after a timeout or restart: its predecessor may be invalidated.
      if (replacement) this.writeVault({ refreshToken: replacement, accessToken: accessValid ? data.access_token : null, accessTokenExpiresAt: lifetimeValid ? this.clock() + data.expires_in * 1000 : this.clock() });
      this.record({ attempts: [...this.current.attempts, attempt], state: 'verifying_api' });
      if (!replacement || !accessValid || !lifetimeValid || String(data.token_type).toLowerCase() !== 'bearer') { const error = new Error('Invalid refresh response'); error.code = 'invalid_token_response'; throw error; }
      const client = new A.VodafoneClient({ fetchImpl: this.fetchImpl, getAccessToken: async ({ forceRefresh } = {}) => { if (forceRefresh) { const error = new Error('API rejected token'); error.code = 'consumer_api_rejected'; throw error; } return data.access_token; } });
      const account = await client.plans();
      if (!hasAccountData(account)) { const error = new Error('Unexpected account'); error.code = 'unexpected_account_response'; throw error; }
      attempt.consumerApiRead = true;
      attempt.serviceCount = A.serviceRoster(account).services.length;
      this.record({ attempts: [...this.current.attempts.slice(0, -1), attempt] });
    }
    this.record({ state: 'complete', completedAt: this.clock(), nextActionAt: null, backendRenewalVerified: this.current.attempts.length === 2 && this.current.attempts.every(attempt => attempt.consumerApiRead && attempt.previousAccessTokenExpired), browserRequiredDuringRenewal: false });
  }
}
module.exports = { RenewalResearch, armRenewalResearch, DIRECTORY, EVIDENCE, CLIENT_ID, TOKEN_URL, REDIRECT_URI };
