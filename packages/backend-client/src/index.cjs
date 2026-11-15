'use strict';
class VodaLensClient {
  constructor({ baseUrl, getSessionToken, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
    const url = new URL(baseUrl);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS backend origin or a loopback development URL.');
    if (typeof getSessionToken !== 'function' || typeof fetchImpl !== 'function') throw new Error('Provide the VodaLens session-token provider and fetch implementation.');
    this.origin = url.origin; this.getSessionToken = getSessionToken; this.fetchImpl = fetchImpl;
  }
  async request(path, { method = 'GET', body, query, signal } = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !path.startsWith('/v1/')) throw new Error('Only the configured VodaLens backend can receive the session token.');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const token = await this.getSessionToken();
    if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('A VodaLens backend session is required.');
    let response;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', redirect: 'error', signal: signal || AbortSignal.timeout(15000) });
    } catch (cause) {
      const timeout = ['AbortError', 'TimeoutError'].includes(cause?.name);
      const error = new Error(timeout ? 'The VodaLens backend request timed out.' : 'The VodaLens backend could not be reached.');
      error.code = timeout ? 'backend_timeout' : 'backend_unreachable';
      throw error;
    }
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error?.message || `VodaLens returned HTTP ${response.status}.`); error.code = data.error?.code; error.status = response.status; throw error; }
    return data;
  }
  capabilities(options) { return this.request('/v1/capabilities', options); }
  authStatus(options) { return this.request('/v1/auth/vodafone/status', options); }
  services(options) { return this.request('/v1/services', options); }
  startVodafoneSignIn(stream, options) { return this.request('/v1/auth/vodafone/start', { ...options, method: 'POST', body: { stream } }); }
  verifyRefresh(options) { return this.request('/v1/auth/vodafone/verify-refresh', { ...options, method: 'POST', body: {} }); }
  connectMyVodafone(accessToken, options) { return this.request('/v1/auth/vodafone/session', { ...options, method: 'POST', body: { source: 'myvodafone-browser', accessToken } }); }
  verifySession(options) { return this.request('/v1/auth/vodafone/verify-session', { ...options, method: 'POST', body: {} }); }
  disconnectVodafone(options) { return this.request('/v1/auth/vodafone/disconnect', { ...options, method: 'POST', body: {} }); }
  syncHistory(selection, options) { return this.request('/v1/usage/sync', { ...options, method: 'POST', body: selection }); }
  history(selection, options) { return this.request('/v1/usage/history', { ...options, query: selection }); }
  consumption(service, options) { return this.request('/v1/usage/consumption', { ...options, query: { service } }); }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { VodaLensClient };
else globalThis.VodaLensClient = VodaLensClient;
