'use strict';
const status = document.getElementById('popup-status');
const buttons = [...document.querySelectorAll('#sync-all, #sync-page')];
async function capture(mode) {
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = 'Reading Vodafone… You can close this popup; the sync will continue.';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, mode, loadMore: document.getElementById('load-more').checked });
    if (response.error) throw new Error(response.error);
    status.textContent = response.state.status.message;
    await chrome.runtime.sendMessage({ type: 'dashboard' });
  } catch (error) { status.textContent = error.message; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
document.getElementById('sync-all').addEventListener('click', () => capture('all'));
document.getElementById('sync-page').addEventListener('click', () => capture('page'));
document.getElementById('open-dashboard').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'dashboard' }));
chrome.storage.onChanged.addListener(changes => {
  const state = changes.state?.newValue;
  if (state?.status?.running) status.textContent = state.status.message;
});
