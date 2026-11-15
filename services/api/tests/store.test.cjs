'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Store } = require('../src/store.cjs');
test('new partial history invalidates stale coverage and retains unaffected date windows', t => {
  const store = new Store({ filename: ':memory:', key: randomBytes(32), clock: () => 1000 });
  t.after(() => store.close());
  const save = (start, end, skipped) => store.saveHistory('owner', { phone: '0400000001', range: { start, end }, skipped, records: [] });
  save('2026-11-01', '2026-11-15', 0);
  save('2026-11-05', '2026-11-10', 2);
  const windows = () => store.history('owner', '0400000001', '2026-11-01', '2026-11-15').windows;
  assert.deepEqual(windows().map(({ start, end, skipped }) => ({ start, end, skipped })), [
    { start: '2026-11-01', end: '2026-11-05', skipped: 0 },
    { start: '2026-11-05', end: '2026-11-10', skipped: 2 },
    { start: '2026-11-10', end: '2026-11-15', skipped: 0 }
  ]);
  save('2026-11-03', '2026-11-12', 0);
  assert.equal(windows().some(window => window.skipped > 0), false);
  assert.equal(windows().length, 3);
});
