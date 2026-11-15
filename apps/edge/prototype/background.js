importScripts('core.js');
const C = globalThis.VodaCore;
let syncing = false;
let writes = Promise.resolve();
async function loadState() {
  const { state } = await chrome.storage.local.get('state');
  if (state) return state;
  let initial = C.emptyState();
  try {
    const response = await fetch(chrome.runtime.getURL('private/initial.json'));
    if (response.ok) initial = await response.json();
  } catch { /* A private seed is optional. */ }
  await chrome.storage.local.set({ state: initial });
  return initial;
}
function mutate(transform) {
  const operation = writes.then(async () => {
    const next = transform(await loadState());
    await chrome.storage.local.set({ state: next });
    return next;
  });
  writes = operation.catch(() => {});
  return operation;
}
chrome.runtime.onInstalled.addListener(() => { loadState(); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const isExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (message.type === 'progress' && sender.tab && !isExtensionPage) {
    mutate(state => ({ ...state, status: { running: true, message: String(message.message).slice(0, 160), errors: [] } }));
    return;
  }
  // Page collectors can only send progress; all operations come from extension pages.
  if (!isExtensionPage) return;
  (async () => {
    if (message.type === 'getState') return { state: await loadState() };
    if (message.type === 'settings') {
      const { cycleDay, allowanceGb } = message.settings || {};
      if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 31 || !Number.isFinite(allowanceGb) || allowanceGb <= 0 || allowanceGb > 100000) throw new Error('Enter a cycle day from 1–31 and a positive allowance.');
      return { state: await mutate(state => ({ ...state, settings: { ...state.settings, cycleDay, allowanceGb } })) };
    }
    if (message.type === 'dashboard') {
      const url = chrome.runtime.getURL('dashboard.html');
      const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
      if (existing) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
      else await chrome.tabs.create({ url });
      return { ok: true };
    }
    if (message.type === 'cancel') {
      const state = await loadState();
      if (state.sourceTabId) await chrome.scripting.executeScript({ target: { tabId: state.sourceTabId }, func: () => { globalThis.__vodaCancel = true; } });
      return { ok: true };
    }
    if (message.type !== 'capture') throw new Error('Unknown operation.');
    if (syncing) throw new Error('A sync is already running.');
    const state = await loadState();
    const tabId = Number.isInteger(message.tabId) ? message.tabId : state.sourceTabId;
    if (!tabId) throw new Error('Click the Voda Lens toolbar icon on your signed-in My Vodafone tab first.');
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== 'https://my.vodafone.com.au') throw new Error('Open My Vodafone and click the Voda Lens toolbar icon to grant access to that tab.');
    syncing = true;
    try {
      await mutate(s => ({ ...s, sourceTabId: tabId, status: { running: true, message: 'Reading My Vodafone…', errors: [] } }));
      await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'collector.js'] });
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async options => globalThis.VodaCollector.capture(options),
        args: [{ mode: message.mode === 'page' ? 'page' : 'all', loadMore: message.loadMore !== false, timezone: state.settings.timezone }]
      });
      const capture = results[0]?.result;
      if (!capture) throw new Error('No data returned from Vodafone.');
      return { state: await mutate(s => C.mergeCapture(s, capture)) };
    } catch (error) {
      await mutate(s => ({ ...s, status: { running: false, message: 'Sync needs attention.', errors: [error.message] } }));
      throw error;
    } finally { syncing = false; }
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
