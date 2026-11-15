'use strict';
const http = require('node:http');
const { timingSafeEqual, createHash } = require('node:crypto');
const C = require('../../../packages/domain/src/index.cjs');
const A = require('../../../packages/vodafone-client/src/index.cjs');
const { AuthError } = require('./oauth.cjs');
const digest = value => createHash('sha256').update(value).digest();
const securityHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
function authenticated(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
}
function range(input, now) {
  let service;
  try { service = A.localPhone(input.service); } catch { throw new AuthError('invalid_service', 'Choose a valid Australian mobile service number.'); }
  const start = input.start, end = input.end;
  if (!C.validDate(start) || !C.validDate(end) || end < start || (Date.parse(end) - Date.parse(start)) / 86400000 > 90 || end > C.todayISO(new Date(now))) throw new AuthError('invalid_range', 'Choose an inclusive date range of at most 91 days, ending no later than today.');
  return { service, start, end, exclusiveEnd: C.addDays(end, 1) };
}
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AuthError('unsupported_content_type', 'Send application/json.', 415);
  let total = 0, chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 16384) throw new AuthError('body_too_large', 'The request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new AuthError('invalid_json', 'Send a JSON object.'); }
}
function createApplication({ config, store, auth, research = null, clock = Date.now }) {
  const authStarts = new Map();
  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && config.allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    try {
      if (origin && !config.allowedOrigins.includes(origin)) throw new AuthError('origin_not_allowed', 'This client origin is not configured.', 403);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...securityHeaders, ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600' }); res.end(); return;
      }
      const url = new URL(req.url, config.publicOrigin);
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok', service: 'vodalens-api' }, cors);
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') return send(res, 200, { streams: config.streams, apiVersion: 1, authMethod: auth.method || 'registered-oauth', registrationRequired: auth.method !== 'myvodafone-session' && !config.clientId, ownerModel: 'single-owner-development', providerTokensOnServerOnly: true, automaticProviderRefresh: auth.method !== 'myvodafone-session' }, cors);
      if (req.method === 'GET' && url.pathname === '/oauth/vodafone/callback') {
        const single = key => { const values = url.searchParams.getAll(key); if (values.length > 1) throw new AuthError('invalid_callback', 'Duplicate authorization parameters.'); return values[0]; };
        await auth.callback({ state: single('state'), code: single('code'), error: single('error') });
        res.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>VodaLens connected</title><h1>Vodafone connected</h1><p>Return to VodaLens. Your sign-in tokens stay in the backend.</p></html>'); return;
      }
      if (!authenticated(req.headers.authorization, config.apiToken)) throw new AuthError('unauthorized', 'A VodaLens backend session token is required.', 401);
      const owner = config.ownerId;
      if (url.pathname.startsWith('/v1/research/vodafone/renewal-probe')) {
        if (config.renewalResearchEnabled !== true || !research || !research.enabled()) throw new AuthError('research_disabled', 'Renewal research is unavailable.', 404);
        if (req.method === 'GET' && url.pathname === '/v1/research/vodafone/renewal-probe') return send(res, 200, research.status(), cors);
        if (req.method === 'POST' && url.pathname === '/v1/research/vodafone/renewal-probe/stage') return send(res, 200, research.stage(await readJson(req)), cors);
        if (req.method === 'POST' && url.pathname === '/v1/research/vodafone/renewal-probe/commit') return send(res, 202, research.commit(await readJson(req)), cors);
        if (req.method === 'POST' && url.pathname === '/v1/research/vodafone/renewal-probe/abort') return send(res, 200, research.abort((await readJson(req)).probeId), cors);
        throw new AuthError('not_found', 'Unknown research action.', 404);
      }
      if (req.method === 'GET' && url.pathname === '/v1/auth/vodafone/status') return send(res, 200, auth.status(owner), cors);
      if (req.method === 'GET' && url.pathname === '/v1/services') {
        const raw = await auth.providerClient(owner).plans();
        return send(res, 200, { ...A.serviceRoster(raw), source: 'myvodafone-api', fetchedAt: clock() }, cors);
      }
      if (req.method === 'POST' && url.pathname === '/v1/auth/vodafone/session') {
        if (typeof auth.importSession !== 'function') throw new AuthError('session_mode_required', 'Select My Vodafone session mode for a browser handoff.', 409);
        return send(res, 200, await auth.importSession(owner, await readJson(req)), cors);
      }
      if (req.method === 'POST' && url.pathname === '/v1/auth/vodafone/verify-session') {
        if (typeof auth.verify !== 'function') throw new AuthError('session_mode_required', 'This route verifies My Vodafone browser sessions.', 409);
        await readJson(req); return send(res, 200, await auth.verify(owner), cors);
      }
      if (req.method === 'POST' && url.pathname === '/v1/auth/vodafone/disconnect') {
        await readJson(req); store.removeConnection(owner); return send(res, 200, auth.status(owner), cors);
      }
      if (req.method === 'POST' && url.pathname === '/v1/auth/vodafone/start') {
        const body = await readJson(req), minute = Math.floor(clock() / 60000);
        const previous = authStarts.get(owner), count = previous?.minute === minute ? previous.count + 1 : 1;
        if (count > 10) throw new AuthError('rate_limited', 'Too many sign-in attempts. Try again in a minute.', 429);
        authStarts.set(owner, { minute, count });
        return send(res, 200, auth.start(owner, body.stream), cors);
      }
      if (req.method === 'POST' && url.pathname === '/v1/auth/vodafone/verify-refresh') {
        await readJson(req);
        if (auth.method === 'myvodafone-session') throw new AuthError('browser_renewal_required', 'Renew access through your normal My Vodafone sign-in, then reconnect the companion.', 409);
        await auth.accessToken(owner, { forceRefresh: true });
        return send(res, 200, auth.status(owner), cors);
      }
      if (req.method === 'POST' && url.pathname === '/v1/usage/sync') {
        const selection = range(await readJson(req), clock());
        const raw = await auth.providerClient(owner).history(selection.service, selection.start, selection.end);
        const line = A.historyRecords(raw, selection.service, selection);
        store.saveHistory(owner, line);
        return send(res, 200, { service: line.phone, range: line.range, fetchedAt: clock(), recordCount: line.records.length, skipped: line.skipped, coverage: line.skipped ? 'partial' : 'provider_date_window', providerCompletenessVerified: false }, cors);
      }
      if (req.method === 'GET' && url.pathname === '/v1/usage/history') {
        const selection = range(Object.fromEntries(url.searchParams), clock());
        const cached = store.history(owner, selection.service, selection.start, selection.exclusiveEnd);
        const seed = { ...C.emptyState(), services: [{ phone: selection.service }], records: cached.records, coverage: cached.windows.filter(w => !w.skipped).map(w => ({ phone: selection.service, start: w.start, end: w.end })) };
        const daily = C.dailyRows(seed, selection.start, selection.exclusiveEnd).map(row => ({ date: row.date, bytes: row.bytes, coverage: cached.windows.some(w => !w.skipped && row.date >= w.start && row.date < w.end) ? 'fetched' : cached.windows.some(w => row.date >= w.start && row.date < w.end) ? 'partial' : 'unknown' }));
        return send(res, 200, { service: selection.service, range: { start: selection.start, end: selection.exclusiveEnd }, source: 'myvodafone-api-cache', daily, windows: cached.windows, windowCoverageComplete: daily.every(day => day.coverage === 'fetched'), providerCompletenessVerified: false }, cors);
      }
      if (req.method === 'GET' && url.pathname === '/v1/usage/consumption') {
        let service;
        try { service = A.localPhone(url.searchParams.get('service')); } catch { throw new AuthError('invalid_service', 'Choose a valid Australian mobile service number.'); }
        const raw = await auth.providerClient(owner).consumption(service);
        return send(res, 200, { service, buckets: A.sharedBuckets([raw]), source: 'myvodafone-api', fetchedAt: clock() }, cors);
      }
      throw new AuthError('not_found', 'No matching VodaLens API route.', 404);
    } catch (error) {
      const known = error instanceof AuthError;
      const status = known ? error.status : [401, 403, 429].includes(error.status) ? 502 : 500;
      send(res, status, { error: { code: known ? error.code : 'upstream_or_internal_error', message: known ? error.message : 'The request could not be completed. No provider credentials or response bodies are included.' } }, cors);
    }
  });
  return server;
}
module.exports = { createApplication, authenticated, range };
