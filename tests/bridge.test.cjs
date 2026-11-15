'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const hook = fs.readFileSync(path.join(__dirname, '../apps/edge/session-bridge/page-hook.js'), 'utf8');
function page() {
  const observed = [], forwarded = [];
  class XHR {
    open(...args) { forwarded.push(['open', ...args]); }
    setRequestHeader(...args) { forwarded.push(['header', ...args]); }
    send(...args) { forwarded.push(['send', ...args]); return 'original-xhr-result'; }
  }
  const window = { fetch: (...args) => { forwarded.push(['fetch', ...args]); return 'original-fetch-result'; }, postMessage: (...args) => observed.push(args) };
  const context = vm.createContext({ window, XMLHttpRequest: XHR, URL, Headers, location: { href: 'https://my.vodafone.com.au/', origin: 'https://my.vodafone.com.au' } });
  vm.runInContext(hook, context);
  return { window, XHR, observed, forwarded, context };
}
const endpoint = 'https://dsapi.vodafone.com.au/tpg-api/customerManagement/v1/customer/planDetails';
test('bridge observes only allowlisted Vodafone API access tokens and preserves fetch', () => {
  const { window, observed, forwarded } = page();
  const token = 'private-session-access-token';
  assert.equal(window.fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } }), 'original-fetch-result');
  assert.equal(observed.length, 1); assert.equal(observed[0][0].accessToken, token);
  assert.equal(observed[0][1], 'https://my.vodafone.com.au');
  for (const url of ['https://other.example/usage', 'https://dsapi.vodafone.com.au/payment', 'https://authn.vodafone.com.au/oauth/token']) window.fetch(url, { headers: { authorization: `Bearer ${token}` } });
  window.fetch(endpoint, { headers: { authorization: 'Basic private-credential' } });
  assert.equal(observed.length, 1); assert.equal(forwarded.length, 5);
});
test('bridge observes XHR at send time, preserves requests and installs only once', () => {
  const { XHR, observed, forwarded, context } = page(), request = new XHR();
  vm.runInContext(hook, context);
  request.open('GET', endpoint, true); request.setRequestHeader('Authorization', 'Bearer private-xhr-session-token');
  assert.equal(observed.length, 0);
  assert.equal(request.send(), 'original-xhr-result');
  assert.equal(observed.length, 1); assert.equal(forwarded.length, 3);
  request.open('GET', 'https://other.example/'); request.send();
  assert.equal(observed.length, 1);
});
