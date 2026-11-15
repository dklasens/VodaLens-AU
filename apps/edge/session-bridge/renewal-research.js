'use strict';
async function refreshResearch() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'researchStatus' });
    if (result.error) { document.getElementById('research-status').textContent = result.error; return; }
    const labels = { waiting_for_expiry: 'Waiting for the access token to expire naturally.', requesting_token: 'Requesting a new token from Vodafone.', verifying_api: 'Verifying the resulting token with the Vodafone API.', complete: 'The independent renewal experiment completed.', failed: 'The experiment stopped and needs review.', interrupted_review_required: 'The backend was interrupted. No automatic retry will occur.', awaiting_browser_release: 'The credential is encrypted; the browser handoff is not complete.' };
    document.getElementById('research-status').textContent = labels[result.state] || 'The experiment is not running.';
    document.getElementById('research-proof').textContent = JSON.stringify({ state: result.state, running: result.running, tokenRequestsStarted: result.tokenRequestsStarted || 0, nextActionAt: result.nextActionAt ? new Date(result.nextActionAt).toLocaleTimeString() : null, attempts: result.attempts || [], backendRenewalVerified: result.backendRenewalVerified || false, failureCode: result.failureCode || null }, null, 2);
  } catch { document.getElementById('research-status').textContent = 'Cannot read the local experiment status. Check that the backend is running.'; }
}
refreshResearch();
setInterval(refreshResearch, 5000);
