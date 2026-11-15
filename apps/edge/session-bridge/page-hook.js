/* Runs only on My Vodafone, in the page's JavaScript world. */
(() => {
  'use strict';
  if (globalThis.__vodaLensSessionHook) return;
  globalThis.__vodaLensSessionHook = true;
  const paths = new Set(['/tpg-api/customerManagement/v1/customer/planDetails', '/tmf-api/usageConsumption/v4/queryUsageConsumption', '/tmf-api/usageManagement/v4/usage']);
  function observe(url, authorization) {
    try {
      const target = new URL(url, location.href);
      if (target.origin !== 'https://dsapi.vodafone.com.au' || !paths.has(target.pathname)) return;
      const match = /^Bearer ([^\s]{16,12000})$/i.exec(authorization || '');
      if (match) window.postMessage({ channel: 'vodalens-session-observed-v1', accessToken: match[1] }, location.origin);
    } catch { /* Observation must not change My Vodafone requests. */ }
  }
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = new Headers(init?.headers || (typeof input === 'object' ? input.headers : undefined));
      observe(typeof input === 'string' || input instanceof URL ? String(input) : input.url, headers.get('authorization'));
    } catch { /* Preserve the original fetch result and errors. */ }
    return Reflect.apply(originalFetch, this, arguments);
  };
  const requests = new WeakMap(), proto = XMLHttpRequest.prototype;
  const open = proto.open, setHeader = proto.setRequestHeader, send = proto.send;
  proto.open = function (method, url) {
    const result = Reflect.apply(open, this, arguments);
    requests.set(this, { url: String(url), authorization: null });
    return result;
  };
  proto.setRequestHeader = function (name, value) {
    const result = Reflect.apply(setHeader, this, arguments);
    const request = requests.get(this);
    if (request && String(name).toLowerCase() === 'authorization') request.authorization = String(value);
    return result;
  };
  proto.send = function () {
    const request = requests.get(this);
    if (request) observe(request.url, request.authorization);
    return Reflect.apply(send, this, arguments);
  };
})();
