/* Isolated world: the page never receives the VodaLens backend credential. */
(() => {
  'use strict';
  if (location.origin !== 'https://my.vodafone.com.au') return;
  let pendingResearch = null;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) || !['prepareRenewalResearch', 'retireRenewalCredential', 'cancelRenewalResearch'].includes(message.type)) return;
    try {
      if (window !== window.top) throw new Error();
      if (message.type === 'cancelRenewalResearch') { pendingResearch = null; respond({ ok: true }); return; }
      if (message.type === 'retireRenewalCredential') {
        if (!pendingResearch || pendingResearch.probeId !== message.probeId) throw new Error();
        const current = JSON.parse(localStorage.getItem(pendingResearch.key) || '{}');
        if (current.body?.refresh_token !== pendingResearch.refreshToken) throw new Error();
        // The backend has encrypted the credential already. Retire this one
        // browser cache entry before it can reuse a predecessor after rotation.
        localStorage.removeItem(pendingResearch.key);
        pendingResearch = null;
        respond({ retired: true }); return;
      }
      const prefix = '@@auth0spajs@@::TE6munQ7o6txJRqZeSzLBzDECX1yVBJO::https://dsapi.vodafone.com.au::';
      const keys = Object.keys(localStorage).filter(key => key.startsWith(prefix));
      if (keys.length !== 1 || typeof message.probeId !== 'string') throw new Error();
      const body = JSON.parse(localStorage.getItem(keys[0]) || '{}').body;
      if (body?.client_id !== 'TE6munQ7o6txJRqZeSzLBzDECX1yVBJO' || body.audience !== 'https://dsapi.vodafone.com.au' || typeof body.refresh_token !== 'string' || body.refresh_token.length < 16 || body.refresh_token.length > 8192 || /\s/.test(body.refresh_token)) throw new Error();
      const claims = JSON.parse(atob(body.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const accessTokenExpiresAt = claims.exp * 1000;
      if (!Number.isSafeInteger(accessTokenExpiresAt) || accessTokenExpiresAt < Date.now() + 90000 || accessTokenExpiresAt > Date.now() + 360000) { respond({ errorCode: 'renewal_stale_page' }); return; }
      pendingResearch = { probeId: message.probeId, key: keys[0], refreshToken: body.refresh_token };
      // This response is reachable only from our trusted background worker,
      // after its explicit user action and a separately armed local experiment.
      respond({ refreshToken: body.refresh_token, accessTokenExpiresAt });
    } catch { pendingResearch = null; respond({ errorCode: 'renewal_cache_unavailable' }); }
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'vodalens-session-observed-v1') return;
    const token = event.data.accessToken;
    if (typeof token !== 'string' || token.length < 16 || token.length > 12000 || /\s/.test(token)) return;
    chrome.runtime.sendMessage({ type: 'observedSession', accessToken: token }).catch(() => {});
  });
})();
