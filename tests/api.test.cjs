const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../packages/vodafone-client/src/index.cjs');
const C = require('../packages/domain/src/index.cjs');
const phone = '0400000001';
const session = (bytes, stamp = '2026-11-15T00:05:00.000') => ({ id: 'Data 322KB', usageDate: stamp, usageType: 'Data', usageCharacteristic: [{ name: 'data-BYTES', value: bytes }] });
const bucket = (used = .48) => ({ usageConsumption: [{ bucketRefOrValue: [{ id: 'SHARED_DATA', name: 'Included data', usageType: 'Discount', bucketCounter: [{ counterType: 'total', value: { amount: 1015, units: 'GB' } }, { counterType: 'used', value: { amount: used, units: 'MB' } }], remainingValue: { amount: 1015, units: 'GB' }, validFor: { startDateTime: '2026-11-15T00:00:00', endDateTime: '2026-12-14T23:59:59' } }] }] });
test('mobile numbers normalize to the API international format', () => {
  assert.equal(A.msisdn(phone), '61400000001');
  assert.equal(A.msisdn('+61 400 000 001'), '61400000001');
  assert.equal(A.localPhone('61400000001'), phone);
  assert.throws(() => A.msisdn('https://example.com'));
});
test('service discovery parses the observed asset schema, deduplicates lines and skips nonmobile assets', () => {
  const asset = { msisdn: '61400000001', displayPlanName: ' Test plan ', accountType: 'Postpaid', serviceType: 'Mobile' };
  const raw = { accountDetails: { accountDetail: { accountNumber: 'private-account', billingAccount: [{ BAN: 'private-billing-account', asset: [asset, { ...asset }, { msisdn: 'not-a-mobile-number' }] }] } } };
  const roster = A.serviceRoster(raw);
  assert.deepEqual(roster, { services: [{ phone, planName: 'Test plan', accountType: 'Postpaid', serviceType: 'Mobile' }], skippedAssets: 1 });
  assert.equal(JSON.stringify(roster).includes('private-account'), false);
  assert.equal(JSON.stringify(roster).includes('private-billing-account'), false);
});
test('service discovery refuses unknown envelopes and conflicting service details', () => {
  assert.throws(() => A.serviceRoster({ accountDetails: [] }), /Unexpected/);
  const assets = [{ msisdn: phone, displayPlanName: 'Plan A' }, { msisdn: phone, displayPlanName: 'Plan B' }];
  assert.throws(() => A.serviceRoster({ accountDetails: { accountDetail: { billingAccount: [{ asset: assets }] } } }), /conflicting/);
});
test('exact bytes are retained without unit rounding or timezone shifts', () => {
  const line = A.historyRecords([session('329728')], phone, { start: '2026-11-15', end: '2026-11-15' });
  assert.equal(line.records[0].bytes, 329728);
  assert.equal(line.records[0].date, '2026-11-15');
  assert.equal(line.records[0].providerTimestamp, '2026-11-15T00:05:00.000');
  assert.equal(line.range.end, '2026-11-16');
});
test('non-data activity is excluded; malformed data remains visible as skipped', () => {
  const line = A.historyRecords([session('garbage'), { usageType: 'Voice' }, session('3', '2026-11-14T00:00:00')], phone, { start: '2026-11-15', end: '2026-11-15' });
  assert.equal(line.records.length, 0); assert.equal(line.skipped, 2); assert.equal(line.nonData, 1);
});
test('provider IDs are not assumed to identify unique sessions', () => {
  const line = A.historyRecords([session('10'), session('10')], phone, { start: '2026-11-15', end: '2026-11-15' });
  assert.notEqual(line.records[0].id, line.records[1].id);
});
test('one shared bucket repeated on three services is counted once', () => {
  const result = A.sharedBuckets([bucket(), bucket(), bucket()]);
  assert.equal(result.length, 1); assert.equal(result[0].totalBytes, 1015 * C.GB);
  assert.equal(result[0].usedBytes, Math.round(.48 * 1024 ** 2));
  assert.equal(result[0].end, '2026-12-15');
});
test('conflicting copies of a shared bucket require a fresh snapshot', () => {
  assert.throws(() => A.sharedBuckets([bucket(), bucket(2)]), /conflicting/);
});
test('per-line counter quotas cannot become a duplicated shared quota', () => {
  const raw = { usageConsumption: [{ overAllTotal: 1680, units: 'GB|MB', bucketRefOrValue: [{ id: '61400000001', usageType: 'Data Consumption Counter', bucketCounter: [{ counterType: 'used', value: { amount: .48, units: 'MB' } }, { counterType: 'total', value: { amount: 560, units: 'GB' } }] }] }] };
  assert.equal(A.sharedBuckets([raw]).length, 0);
  assert.deepEqual(Object.keys(A.accountCounters(raw)[0]), ['phone', 'usedBytes', 'reportedEnd']);
});
test('API client only sends GETs to observed Vodafone endpoints', async () => {
  let captured;
  const client = new A.VodafoneClient({ getAccessToken: async () => 'test-token', makeTraceId: () => 'test-trace', fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, json: async () => [] }; } });
  await client.history(phone, '2026-11-09', '2026-11-15');
  const url = new URL(captured.url);
  assert.equal(url.origin, A.ORIGIN); assert.equal(url.searchParams.get('id'), '61400000001');
  assert.equal(captured.options.method, 'GET'); assert.equal(captured.options.credentials, 'omit');
  assert.equal(captured.options.redirect, 'error'); assert.equal(captured.options.headers.authorization, 'Bearer test-token');
  await assert.rejects(client.read('https://example.com/steal'), /Unsupported/);
});
test('expired access refreshes through the caller once; tokens are not persisted', async () => {
  const calls = []; let requests = 0;
  const client = new A.VodafoneClient({ getAccessToken: async options => { calls.push(options.forceRefresh); return 'test-token'; }, makeTraceId: () => 'trace', fetchImpl: async () => ++requests === 1 ? { ok: false, status: 401 } : { ok: true, json: async () => ({}) } });
  await client.consumption(phone); assert.deepEqual(calls, [false, true]); assert.equal(requests, 2);
});
test('rate-limit and authorization errors do not leak response bodies', async () => {
  const client = new A.VodafoneClient({ getAccessToken: async () => 'test-token', makeTraceId: () => 'trace', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'private response' }) });
  await assert.rejects(client.plans(), error => error.status === 429 && !error.message.includes('private'));
});
