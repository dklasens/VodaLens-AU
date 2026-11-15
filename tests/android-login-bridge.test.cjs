'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('apps/android/app/src/main/java/au/com/vodalens/VodafoneLogin.kt', 'utf8');
const prefix = source.match(/private const val CACHE_PREFIX = "([^"]+)"/)[1];
function script(name) { return source.match(new RegExp(`private val ${name} = """\\n([\\s\\S]*?)\\n"""\\.trimIndent\\(\\)`))[1].replace('$CACHE_PREFIX', prefix); }
function page({ origin = 'https://my.vodafone.com.au', frame = false, interactive = false } = {}) {
  let tick = () => {};
  const messages = [];
  const key = prefix + 'test-scope';
  const context = { document: { querySelectorAll: () => interactive ? [{ type: 'email', getClientRects: () => [{}] }] : [] }, location: { origin }, localStorage: { [key]: JSON.stringify({ body: { access_token: 'sample-access', refresh_token: 'sample-refresh' } }) }, VodaLensBridge: { postMessage: raw => messages.push(JSON.parse(raw)) }, crypto: { randomUUID: () => 'test-transaction-0001' }, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {} };
  Object.defineProperty(context.localStorage, 'getItem', { value: key => context.localStorage[key] });
  Object.defineProperty(context.localStorage, 'removeItem', { value: key => { delete context.localStorage[key]; } });
  context.window = context;
  context.top = frame ? {} : context;
  context.stop = () => { context.stopped = true; };
  vm.runInNewContext(script('LOGIN_OBSERVER'), context);
  return { context, messages, key, tick: () => tick(), commit: (transaction, extra = {}) => context.VodaLensBridge.onmessage({ data: JSON.stringify({ type: 'commit', transaction, ...extra }) }) };
}
test('observer only operates in the exact Vodafone main frame', () => {
  assert.equal(page({ origin: 'https://attacker.example' }).context.__lensTake, undefined);
  assert.equal(page({ frame: true }).context.__lensTake, undefined);
});
test('token-free native commit lets page retire only its own captured entry', () => {
  const p = page(); p.context.__lensTake(); p.context.__lensTake();
  assert.equal(p.messages.length, 1);
  const sent = p.messages[0]; assert.equal(sent.type, 'credential');
  p.commit(sent.transaction);
  assert.equal(p.context.localStorage[p.key], undefined);
  assert.deepEqual(p.messages[1], { type: 'retired', transaction: sent.transaction });
  assert.equal(p.context.stopped, true);
  p.commit(sent.transaction);
  assert.equal(p.messages.length, 2);
});
test('cache rotation between staging and commit preserves replacement and refuses handoff', () => {
  const p = page(); p.context.__lensTake();
  const transaction = p.messages[0].transaction;
  const replacement = JSON.stringify({ body: { access_token: 'replacement-access', refresh_token: 'replacement-refresh' } });
  p.context.localStorage[p.key] = replacement;
  p.commit(transaction, { refresh: 'sample-refresh', key: p.key });
  assert.equal(p.context.localStorage[p.key], replacement);
  assert.deepEqual(p.messages[1], { type: 'changed', transaction });
  assert.equal(p.context.stopped, undefined);
});
test('foreign or stale transaction does not retire a cache entry', () => {
  const p = page(); p.context.__lensTake();
  p.commit('different-transaction-0002');
  assert.ok(p.context.localStorage[p.key]); assert.equal(p.messages.length, 1);
  p.commit(p.messages[0].transaction);
  assert.equal(p.context.localStorage[p.key], undefined);
});
test('native credential path has no token interpolation into JavaScript', () => {
  assert.doesNotMatch(source, /evaluateJavascript\([^\n]*(?:JSONObject\.quote|refresh|access)/);
  assert.match(source, /reply\.postMessage\(JSONObject\(\)\.put\("type", "commit"\)\.put\("transaction", transaction\)/);
});
function formPage() {
  const callbacks = {};
  const sent = [];
  class Form { submit() { sent.push(this.action); } requestSubmit(button) { sent.push(button?.formAction || this.action); } }
  const c = { URL, location: { href: 'https://authn.vodafone.com.au/login' }, document: { addEventListener: (name, callback) => { callbacks[name] = callback; } }, HTMLFormElement: Form };
  c.window = c;
  vm.runInNewContext(script('LOGIN_NAVIGATION_GUARD'), c);
  return { callbacks, sent, Form };
}
test('form guard blocks off-origin normal and programmatic submissions', () => {
  const p = formPage(); const form = new p.Form(); form.action = 'https://attacker.example/collect';
  let prevented = false;
  p.callbacks.submit({ target: form, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.equal(prevented, true);
  form.submit(); form.requestSubmit(); assert.deepEqual(p.sent, []);
  form.action = 'https://authn.vodafone.com.au/login'; form.submit();
  assert.deepEqual(p.sent, [form.action]);
});
test('submitter action cannot override a trusted form with an external destination', () => {
  const p = formPage(); const form = new p.Form(); form.action = 'https://authn.vodafone.com.au/login';
  const submitter = { formAction: 'https://attacker.example/collect', hasAttribute: () => true };
  let prevented = false;
  p.callbacks.submit({ target: form, submitter, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  form.requestSubmit(submitter);
  assert.equal(prevented, true); assert.deepEqual(p.sent, []);
});

test('default submitter formAction cannot disguise an external form action', () => {
  const p = formPage(); const form = new p.Form(); form.action = 'https://attacker.example/collect';
  const submitter = { formAction: 'https://authn.vodafone.com.au/login', hasAttribute: () => false };
  let prevented = false;
  p.callbacks.submit({ target: form, submitter, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  form.requestSubmit(submitter);
  assert.equal(prevented, true); assert.deepEqual(p.sent, []);
});

test('readiness reports a visible login form without reading input values', () => {
  const p = page({ interactive: true });
  delete p.context.localStorage[p.key];
  p.tick();
  assert.deepEqual(p.messages[0], { type: 'ready', ready: false, interactive: true });
});
