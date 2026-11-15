'use strict';
importScripts('backend-client.js');
let clientPromise, importing = false;
let researchEnabled = false;
async function client() {
  if (!clientPromise) clientPromise = (async () => {
    const response = await fetch(chrome.runtime.getURL('local-config.json'));
    if (!response.ok) { const error = new Error(); error.code = 'invalid_configuration'; throw error; }
    const config = await response.json();
    if (config.backendOrigin !== 'http://127.0.0.1:8766') { const error = new Error(); error.code = 'invalid_configuration'; throw error; }
    researchEnabled = config.renewalResearchEnabled === true;
    return new VodaLensClient({ baseUrl: config.backendOrigin, getSessionToken: () => config.backendToken });
  })().catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
async function bridgeState() {
  const { bridge } = await chrome.storage.session.get('bridge');
  return bridge || { armed: false, message: 'Open your signed-in My Vodafone tab, then choose Connect.' };
}
async function publish(bridge) { await chrome.storage.session.set({ bridge }); return bridge; }
function explain(error) {
  const messages = {
    backend_unreachable: 'Cannot reach the local VodaLens backend at 127.0.0.1:8766. Start it with npm start, then retry.',
    backend_timeout: 'The local VodaLens backend timed out. Check that it is running, then retry.',
    unauthorized: 'The addon’s backend key is out of date. Rebuild the bridge with npm run bridge:build, then reload it in Edge extensions.',
    origin_not_allowed: 'The backend does not recognize this addon. Rebuild the bridge, restart the backend, then reload the addon.',
    not_connected: 'No Vodafone session is connected yet. Open My Vodafone and choose Connect this tab.',
    reconnect_required: 'The Vodafone session needs reconnecting. Refresh My Vodafone, then choose Connect this tab.',
    session_expired: 'The observed Vodafone access token has expired. Sign in to My Vodafone again, then reconnect.',
    session_rejected: 'Vodafone rejected the observed session. Sign in to My Vodafone again, then reconnect.',
    unexpected_api_response: 'Vodafone did not return the expected account data. The session was not saved.',
    wrong_tab: 'Open your My Vodafone tab before choosing Connect this tab.',
    research_disabled: 'Browser renewal research is disabled. An explicit local research opt-in and rebuild are required.',
    renewal_not_armed: 'The one-time renewal experiment is not armed. It requires explicit approval and preparation first.',
    renewal_stale_page: 'Refresh My Vodafone normally, then retry the experiment while its access token is fresh.',
    renewal_cache_unavailable: 'The expected Vodafone refresh credential is unavailable or changed. No renewal request was sent.',
    renewal_multiple_tabs: 'Keep only one My Vodafone tab open for the ownership-transfer experiment.',
    renewal_interrupted: 'The renewal experiment needs review. Do not retry it automatically; you may need to sign in to My Vodafone again.',
    invalid_configuration: 'The addon’s local configuration is missing or invalid. Run npm run bridge:build, then reload the addon.'
  };
  return messages[error?.code] || 'The connection action failed. Reload VodaLens from Edge extensions and try again.';
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  (async () => {
    if (message.type === 'observedSession') {
      if (extensionPage || sender.frameId !== 0 || !sender.tab || new URL(sender.url).origin !== 'https://my.vodafone.com.au') return;
      const state = await bridgeState();
      if (!state.armed || sender.tab.id !== state.tabId || state.until <= Date.now() || importing) return;
      importing = true;
      try {
        const result = await (await client()).connectMyVodafone(message.accessToken);
        await publish({ armed: false, message: 'Connected. The backend verified this session with Vodafone.', status: result });
      } catch (error) {
        await publish({ ...state, message: explain(error) });
      } finally { importing = false; }
      return { ok: true };
    }
    if (!extensionPage) return;
    if (['researchStatus', 'testBackendRenewal'].includes(message.type)) {
      await client();
      if (!researchEnabled) { const error = new Error(); error.code = 'research_disabled'; throw error; }
    }
    if (message.type === 'researchStatus') return (await client()).request('/v1/research/vodafone/renewal-probe');
    if (message.type === 'testBackendRenewal') {
      if (importing) { const error = new Error(); error.code = 'renewal_interrupted'; throw error; }
      const backend = await client();
      const arm = await backend.request('/v1/research/vodafone/renewal-probe');
      if (!arm.armed) { const error = new Error(); error.code = 'renewal_not_armed'; throw error; }
      const tabs = await chrome.tabs.query({ url: 'https://my.vodafone.com.au/*' });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length !== 1) { const error = new Error(); error.code = 'renewal_multiple_tabs'; throw error; }
      if (!tab || tab.id !== tabs[0].id) { const error = new Error(); error.code = 'wrong_tab'; throw error; }
      importing = true;
      let packet, staged = false, retired = false;
      try {
        await publish({ armed: false, message: 'Preparing the approved renewal experiment.' });
        packet = await chrome.tabs.sendMessage(tab.id, { type: 'prepareRenewalResearch', probeId: arm.probeId }, { frameId: 0 });
        if (!packet || packet.errorCode) { const error = new Error(); error.code = packet?.errorCode || 'renewal_cache_unavailable'; throw error; }
        await backend.request('/v1/research/vodafone/renewal-probe/stage', { method: 'POST', body: { probeId: arm.probeId, refreshToken: packet.refreshToken, accessTokenExpiresAt: packet.accessTokenExpiresAt } });
        staged = true;
        const released = await chrome.tabs.sendMessage(tab.id, { type: 'retireRenewalCredential', probeId: arm.probeId }, { frameId: 0 });
        if (!released?.retired) { const error = new Error(); error.code = 'renewal_interrupted'; throw error; }
        retired = true;
        await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('renewal-research.html') });
        await backend.request('/v1/research/vodafone/renewal-probe/commit', { method: 'POST', body: { probeId: arm.probeId, browserReleased: true } });
        return { ok: true, message: 'The backend experiment has started. Its status is shown in this tab.' };
      } catch (error) {
        if (staged && !retired) await backend.request('/v1/research/vodafone/renewal-probe/abort', { method: 'POST', body: { probeId: arm.probeId } }).catch(() => {});
        if (!retired) await chrome.tabs.sendMessage(tab.id, { type: 'cancelRenewalResearch', probeId: arm.probeId }, { frameId: 0 }).catch(() => {});
        throw error;
      } finally { if (packet) packet.refreshToken = null; packet = undefined; importing = false; }
    }
    if (message.type === 'state') {
      const bridge = await bridgeState();
      try {
        const status = await (await client()).authStatus();
        if (bridge.armed && bridge.until > Date.now()) return { ...bridge, status };
        const text = status.connected ? 'Connected. The backend verified this session with Vodafone.' : status.state === 'reconnect_required' ? 'Your Vodafone session has expired. Open My Vodafone and choose Connect this tab again.' : 'Open your signed-in My Vodafone tab, then choose Connect.';
        return publish({ armed: false, message: text, status });
      } catch (error) { return { ...bridge, message: explain(error) }; }
    }
    if (message.type === 'connect') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || new URL(tab.url).origin !== 'https://my.vodafone.com.au') { const error = new Error(); error.code = 'wrong_tab'; throw error; }
      await (await client()).capabilities();
      await publish({ armed: true, tabId: tab.id, until: Date.now() + 300000, message: 'Waiting for My Vodafone. Sign in if needed; the next account request will connect.' });
      await chrome.tabs.reload(tab.id);
      return bridgeState();
    }
    if (message.type === 'verify') {
      const status = await (await client()).verifySession();
      return publish({ armed: false, message: 'Verified a fresh read from the Vodafone API.', status });
    }
    if (message.type === 'disconnect') {
      const status = await (await client()).disconnectVodafone();
      return publish({ armed: false, message: 'Disconnected. The backend removed its Vodafone access token.', status });
    }
    throw new Error('Unknown companion action.');
  })().then(respond, error => respond({ error: explain(error) }));
  return true;
});
