// Imports an already sanitized, usage-only trace. Never accepts or stores tokens.
const fs = require('node:fs');
const path = require('node:path');
const A = require('../packages/vodafone-client/src/index.cjs');
const C = require('../packages/domain/src/index.cjs');
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/import-api-capture.cjs /path/to/usage-only.json');
const entries = JSON.parse(fs.readFileSync(input));
const destination = path.join(__dirname, '../local-data/vodafone-capture.json');
let state = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination)) : C.emptyState();
state.records = state.records.filter(r => r.kind !== 'bill'); state.bills = [];
const responses = [], counters = [];
const capturedAt = new Date().toISOString();
let windows = 0;
for (const entry of entries) {
  if (entry.request.method !== 'GET' || entry.response.status !== 200) continue;
  const url = new URL(entry.request.url);
  if (url.origin !== A.ORIGIN) throw new Error('Only the Vodafone API origin is accepted.');
  if (entry.request.headers.some(h => /authorization|cookie/i.test(h.name))) throw new Error('Remove credentials from the capture first.');
  const raw = JSON.parse(entry.response.content.text);
  if (url.pathname === A.PATHS.history) {
    const line = A.historyRecords(raw, url.searchParams.get('id'), { start: url.searchParams.get('startdate'), end: url.searchParams.get('enddate') });
    line.name = state.services.find(s => s.phone === line.phone)?.name || 'Mobile service';
    state = C.mergeCapture(state, { capturedAt, lines: [line] }); windows++;
  } else if (url.pathname === A.PATHS.consumption) {
    if (url.searchParams.has('customerAccountNumber')) counters.push(...A.accountCounters(raw));
    else responses.push(raw);
  }
}
const shared = A.sharedBuckets(responses);
const pool = shared.find(bucket => bucket.totalBytes === state.settings.allowanceGb * C.GB);
if (pool) {
  state.pool = { ...pool, reportedDate: C.todayISO(), capturedAt, source: 'My Vodafone shared-bucket API' };
  state.counterPeriod = { start: pool.start, end: pool.end };
}
if (counters.length) state.lineCounters = [...new Map(counters.map(counter => [counter.phone, counter])).values()];
state.lastSync = capturedAt;
state.status = { running: false, message: 'Imported verified My Vodafone API responses.', errors: [] };
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
console.log(`Imported ${windows} API date windows; ${state.records.length} unique data sessions across ${new Set(state.records.map(r => r.phone)).size} lines. No PDF usage or credentials stored.`);
