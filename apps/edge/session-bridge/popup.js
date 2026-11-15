'use strict';
const status = document.getElementById('status');
async function show(type) {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({ type });
    status.textContent = result?.error || result?.message || 'Open My Vodafone to connect.';
  } catch { status.textContent = 'The companion is unavailable. Reload it from Edge extensions.'; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
for (const type of ['connect', 'verify', 'disconnect', 'testBackendRenewal']) document.getElementById(type).addEventListener('click', () => show(type));
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.bridge?.newValue) status.textContent = changes.bridge.newValue.message; });
show('state');
