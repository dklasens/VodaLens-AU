const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../packages/domain/src/index.cjs');
const phone = '0400000001';
const home = `Hello TEST\nMy products & services\nSmall Plan\n0400 000 001\nData\n1015.00 GB remaining\nResets in 30 days\nLarge SIM Only Plan\n0400 000 002\nData\n1015.00 GB remaining\nResets in 30 days\nManage account\nYour details`;
const usage = `My products & services\nSmall Plan\n0400 000 001\nMy plan\nUsage\nUsage history\nFilter by date\nSee all\nData\nToday\nData session\n$0.00\n12:46:39 AM\n38.0 kB\nData session\n$0.00\n02:21:22 AM\n257.0 kB\nYesterday\nData session\n$0.00\n03:05:25 PM\n200.0 MB\n14 Nov 2026\nData session\n10:00:00 PM\n1.5 GB\nShow more`;
test('Vodafone binary units: 1 GB = 1024 MB', () => {
  assert.equal(C.toBytes('1', 'GB'), C.toBytes('1024', 'MB'));
  assert.equal(C.toBytes('1,015.00', 'GB'), 1015 * C.GB);
  assert.equal(C.toBytes('-1', 'GB'), null);
});
test('calendar dates reject invalid day rollover', () => {
  assert.equal(C.validDate('2026-02-30'), false);
  assert.equal(C.validDate('2028-02-29'), true);
});
test('cycle boundaries use inclusive start and exclusive end', () => {
  assert.deepEqual(C.cycleFor('2026-11-15'), { start: '2026-11-15', end: '2026-12-15', last: '2026-12-14', days: 30 });
  assert.equal(C.cycleFor('2026-11-14').start, '2026-10-15');
  assert.equal(C.cycleFor('2026-01-01').start, '2025-12-15');
});
test('31st cycle day clamps to short months and returns to the 31st', () => {
  assert.equal(C.cycleFor('2026-02-28', 31).end, '2026-03-31');
  assert.equal(C.cycleFor('2026-02-27', 31).start, '2026-01-31');
});
test('cycle progress respects Sydney local date across UTC midnight', () => {
  const now = new Date('2026-11-14T22:00:00Z');
  assert.equal(C.todayISO(now), '2026-11-15');
  const progress = C.cycleProgress(C.cycleFor(C.todayISO(now)), now);
  assert.equal(progress.day, 1);
  assert.equal(progress.daysLeft, 30);
  assert.ok(Math.abs(progress.percent - 1.25) < .0001);
});
test('historical cycle reaches 100 percent and future cycle stays at zero', () => {
  const now = new Date('2026-11-14T22:00:00Z');
  assert.equal(C.cycleProgress(C.cycleFor('2026-09-20'), now).percent, 100);
  assert.equal(C.cycleProgress(C.cycleFor('2026-12-20'), now).percent, 0);
});
test('relative and weekday date headings resolve in Australia', () => {
  assert.equal(C.dateHeading('Yesterday', '2026-11-15'), '2026-11-14');
  assert.equal(C.dateHeading('Friday', '2026-11-15'), '2026-11-13');
  assert.equal(C.dateHeading('Sunday, November 15, 2026', '2026-11-15'), '2026-11-15');
  assert.equal(C.dateHeading('14/11/2026', '2026-11-15'), '2026-11-14');
});
test('yearless headings at New Year resolve to the previous year', () => {
  assert.equal(C.dateHeading('31 Dec', '2027-01-01'), '2026-12-31');
  assert.equal(C.dateHeading('29 February 2026', '2026-11-15'), null);
});
test('home parser identifies services without summing shared balances', () => {
  const parsed = C.parseHome(home);
  assert.equal(parsed.services.length, 2);
  assert.equal(parsed.services[0].phone, phone);
  const state = C.mergeCapture(C.emptyState(), { home: parsed, today: '2026-11-15', capturedAt: '2026-11-15', lines: [] });
  assert.equal(state.pool.remainingBytes, 1015 * C.GB);
});
test('a service breadcrumb cannot masquerade as the home roster', () => {
  assert.equal(C.parseHome(usage), null);
});
test('different per-line balances cannot be treated as a shared pool', () => {
  const parsed = C.parseHome(home.replace('1015.00 GB remaining', '10.00 GB remaining'));
  assert.equal(C.mergeCapture(C.emptyState(), { home: parsed, lines: [] }).pool, null);
});
test('usage parser resolves dates, amounts and 12-hour timestamps', () => {
  const result = C.parseUsage(usage, { today: '2026-11-15' });
  assert.equal(result.records.length, 4);
  assert.equal(result.phone, phone);
  assert.equal(result.name, 'Small Plan');
  assert.equal(result.records[0].time, '00:46:39');
  assert.equal(result.records[2].time, '15:05:25');
  assert.equal(result.records[2].date, '2026-11-14');
  assert.equal(result.records[3].bytes, 1.5 * C.GB);
});
test('duplicate captures upsert sessions rather than adding usage twice', () => {
  const line = C.parseUsage(usage, { today: '2026-11-15' });
  const capture = { lines: [line], capturedAt: '2026-11-15' };
  const once = C.mergeCapture(C.emptyState(), capture);
  const twice = C.mergeCapture(once, capture);
  assert.equal(twice.records.length, 4);
  assert.equal(C.totalsFor(once, '2026-11-15', '2026-12-15').bytes, C.totalsFor(twice, '2026-11-15', '2026-12-15').bytes);
});
test('legitimate identical sessions retain their occurrence count', () => {
  const row = '\nData session\n12:00:00 PM\n200 MB';
  const result = C.parseUsage(`Small Plan\n0400 000 001\nUsage history\nToday${row}${row}`, { today: '2026-11-15' });
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].id, result.records[1].id);
});
test('undated and unreadable sessions are excluded with a warning', () => {
  const result = C.parseUsage('Small Plan\n0400 000 001\nUsage history\nData session\n1 GB\nToday\nData session\n$0.00', { today: '2026-11-15' });
  assert.equal(result.records.length, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.warnings.length, 1);
});
test('an unrecognized date cannot reuse the preceding day silently', () => {
  const result = C.parseUsage('Small Plan\n0400 000 001\nUsage history\nToday\nData session\n1 GB\n13 Smarch 2026\nData session\n2 GB', { today: '2026-11-15' });
  assert.equal(result.records.length, 1);
  assert.equal(result.skipped, 1);
});
test('an empty list does not silently establish zero usage', () => {
  const result = C.parseUsage('Small Plan\n0400 000 001\nUsage history\nLoading', { today: '2026-11-15' });
  assert.match(result.warnings[0], /not evidence of zero/);
});
test('date modal cannot be captured accidentally', () => {
  assert.throws(() => C.parseUsage(`${usage}\nFilter history`, { today: '2026-11-15' }), /Close the date filter/);
});
test('unknown days stay null; an explicit zero-byte session is zero', () => {
  const state = C.emptyState(); state.services = [{ phone, name: 'Test' }];
  state.records = [{ id: 'zero', phone, date: '2026-11-15', bytes: 0, kind: 'session' }];
  const rows = C.dailyRows(state, '2026-11-15', '2026-11-17');
  assert.equal(rows[0].bytes, 0);
  assert.equal(rows[1].bytes, null);
});
test('bill daily records supersede overlapping browser sessions', () => {
  const state = C.emptyState(); state.services = [{ phone }];
  state.records = [{ id: 'a', phone, date: '2026-09-15', bytes: C.GB, kind: 'bill' }, { id: 'b', phone, date: '2026-09-15', bytes: C.GB, kind: 'session' }];
  state.bills = [{ start: '2026-09-15', end: '2026-10-15', phones: [phone], totals: { [phone]: 1.01 * C.GB } }];
  const totals = C.totalsFor(state, '2026-09-15', '2026-10-15');
  assert.equal(totals.rows[0].bytes, C.GB);
  assert.equal(totals.bytes, 1.01 * C.GB);
  assert.equal(totals.rows[1].bytes, 0);
});
test('a previous-cycle balance cannot be reused after reset', () => {
  const state = C.emptyState(); state.settings.allowanceGb = 1015;
  state.pool = { remainingBytes: 500 * C.GB, reportedDate: '2026-11-14' };
  assert.equal(C.poolUsage(state, C.cycleFor('2026-11-15')), null);
  state.pool.reportedDate = '2026-11-15';
  assert.equal(C.poolUsage(state, C.cycleFor('2026-11-15')).usedBytes, 515 * C.GB);
});
test('capturing a disjoint account does not merge its data', () => {
  const state = C.emptyState(); state.services = [{ phone }];
  assert.throws(() => C.mergeCapture(state, { home: { services: [{ phone: '0499999999', name: 'Other' }] }, lines: [] }), /different account/);
});
