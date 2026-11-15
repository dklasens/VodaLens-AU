/* Shared by the extension, the page collector and dependency-free Node tests. */
(function (root) {
  'use strict';
  const GB = 1024 ** 3;
  const DAY = 86400000;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const clean = text => String(text || '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\r/g, '');
  const linesOf = text => clean(text).split('\n').map(x => x.trim()).filter(Boolean);
  const iso = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const utc = date => Date.parse(`${date}T00:00:00Z`);
  const addDays = (date, days) => new Date(utc(date) + days * DAY).toISOString().slice(0, 10);
  function validDate(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(utc(date)) && new Date(utc(date)).toISOString().slice(0, 10) === date;
  }
  function zonedParts(now = new Date(), zone = 'Australia/Sydney') {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  }
  function todayISO(now = new Date(), zone = 'Australia/Sydney') {
    const p = zonedParts(now, zone);
    return iso(p.year, p.month, p.day);
  }
  function monthAnchor(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, 1));
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1;
    const max = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return iso(y, m, Math.min(day, max));
  }
  function cycleFor(date, day = 15) {
    if (!validDate(date) || !Number.isInteger(day) || day < 1 || day > 31) throw new Error('Invalid billing-cycle date.');
    const [year, month] = date.split('-').map(Number);
    const anchor = monthAnchor(year, month, day);
    const start = date >= anchor ? anchor : monthAnchor(year, month - 1, day);
    const [sy, sm] = start.split('-').map(Number);
    const end = monthAnchor(sy, sm + 1, day);
    return { start, end, last: addDays(end, -1), days: Math.round((utc(end) - utc(start)) / DAY) };
  }
  function cycleProgress(cycle, now = new Date(), zone = 'Australia/Sydney') {
    const p = zonedParts(now, zone), today = iso(p.year, p.month, p.day);
    const elapsed = (utc(today) - utc(cycle.start)) / DAY + (p.hour * 3600 + p.minute * 60 + p.second) / 86400;
    const bounded = Math.max(0, Math.min(cycle.days, elapsed));
    return { percent: bounded / cycle.days * 100, day: Math.min(cycle.days, Math.max(1, Math.floor(bounded) + 1)), daysLeft: Math.ceil(cycle.days - bounded) };
  }
  function toBytes(value, unit) {
    const power = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4 }[unit.toLowerCase()];
    const number = Number(String(value).replace(/,/g, ''));
    if (power === undefined || !Number.isFinite(number) || number < 0) return null;
    const bytes = Math.round(number * 1024 ** power);
    return Number.isSafeInteger(bytes) ? bytes : null;
  }
  function formatData(bytes, precision = 2) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
    if (bytes === 0) return '0 GB';
    const power = Math.max(1, Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))));
    return `${(bytes / 1024 ** power).toLocaleString('en-AU', { maximumFractionDigits: precision })} ${['B', 'kB', 'MB', 'GB', 'TB'][power]}`;
  }
  const phonePattern = /\b0[45](?:[\s-]?\d){8}\b/g;
  const phoneId = value => String(value).replace(/\D/g, '');
  const displayPhone = value => value.length === 10 ? `${value.slice(0, 4)} ${value.slice(4, 7)} ${value.slice(7)}` : value;
  function dateHeading(text, today) {
    const value = clean(text).trim().replace(/[,]/g, '').replace(/^(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\s+(?=\d|[A-Za-z])/i, '');
    if (/^today$/i.test(value)) return today;
    if (/^yesterday$/i.test(value)) return addDays(today, -1);
    if (validDate(value)) return value;
    let match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) { const d = iso(+match[3], +match[2], +match[1]); return validDate(d) ? d : null; }
    match = value.match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+)?(\d{1,2})[\s-]+([A-Za-z]{3,9})(?:[\s-]+(\d{4}))?$/i);
    if (!match) {
      const reverse = value.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?$/);
      if (reverse) match = [reverse[0], reverse[2], reverse[1], reverse[3]];
    }
    if (match) {
      const month = months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
      if (!month) return null;
      let year = match[3] ? +match[3] : +today.slice(0, 4);
      let date = iso(year, month, +match[1]);
      if (!match[3] && date > today) date = iso(--year, month, +match[1]);
      return validDate(date) ? date : null;
    }
    if (/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i.test(value)) {
      const target = weekdays.indexOf(value.slice(0, 3).toLowerCase());
      const diff = (new Date(utc(today)).getUTCDay() - target + 7) % 7;
      return addDays(today, -diff);
    }
    return null;
  }
  function parseHome(text) {
    const all = linesOf(text);
    const start = all.findIndex(line => /^my products\s*(?:&|and)\s*services$/i.test(line));
    if (start < 0) return null;
    const end = all.findIndex((line, i) => i > start && /^manage account$/i.test(line));
    if (end < 0) return null;
    const section = all.slice(start + 1, end < 0 ? undefined : end);
    const services = [];
    for (let i = 0; i < section.length; i++) {
      const match = section[i].match(new RegExp(`^${phonePattern.source}$`));
      if (!match) continue;
      const phone = phoneId(match[0]);
      if (services.some(s => s.phone === phone)) continue;
      const next = section.slice(i + 1, i + 7).join('\n');
      const amount = next.match(/([\d,.]+)\s*(GB|MB|kB)\s+remaining/i);
      const reset = next.match(/resets in\s+(\d+)\s+days?/i);
      services.push({ phone, name: section[i - 1] || 'Mobile service', remainingBytes: amount ? toBytes(amount[1], amount[2]) : null, resetsIn: reset ? +reset[1] : null });
    }
    return services.length ? { services } : null;
  }
  function parseUsage(text, { today, phone: suppliedPhone, name: suppliedName } = {}) {
    if (!validDate(today)) throw new Error('A capture date is required.');
    const all = linesOf(text);
    const start = all.findIndex(line => /^usage history$/i.test(line));
    if (start < 0) throw new Error('Open a service’s Usage tab first.');
    if (all.some(line => /^filter history$/i.test(line))) throw new Error('Close the date filter before syncing.');
    const header = all.slice(0, start);
    const matches = [...header.join('\n').matchAll(phonePattern)];
    const phone = suppliedPhone || (matches.length ? phoneId(matches.at(-1)[0]) : null);
    if (!phone) throw new Error('The selected service number could not be identified.');
    const phoneIndex = header.findLastIndex(line => phoneId(line) === phone);
    const name = suppliedName || (phoneIndex > 0 ? header[phoneIndex - 1] : 'Mobile service');
    const records = [], warnings = [], ordinals = new Map();
    let date = null, skipped = 0, sessionCount = 0;
    for (let i = start + 1; i < all.length; i++) {
      const heading = dateHeading(all[i], today);
      if (heading) { date = heading; continue; }
      if (/^(?:[A-Za-z]+[, ]+)?(?:\d{1,2}[-/ ]+[A-Za-z]+|[A-Za-z]+ +\d{1,2})/.test(all[i])) date = null;
      if (!/^data session$/i.test(all[i])) continue;
      sessionCount++;
      let stop = i + 1;
      while (stop < all.length && !/^data session$/i.test(all[stop]) && !dateHeading(all[stop], today) && stop < i + 12) stop++;
      const block = all.slice(i + 1, stop).join('\n');
      const amount = block.match(/\b([\d,]+(?:\.\d+)?)\s*(kB|MB|GB|TB|B)\b/i);
      const timeMatch = block.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/i);
      const bytes = amount ? toBytes(amount[1], amount[2]) : null;
      if (!date || bytes === null || date > today) { skipped++; continue; }
      let time = null;
      if (timeMatch) {
        let hour = +timeMatch[1];
        if (timeMatch[4]) hour = hour % 12 + (/pm/i.test(timeMatch[4]) ? 12 : 0);
        if (hour < 24 && +timeMatch[2] < 60 && +(timeMatch[3] || 0) < 60) time = `${String(hour).padStart(2, '0')}:${timeMatch[2]}:${timeMatch[3] || '00'}`;
      }
      const signature = `${phone}|${date}|${time || ''}|${bytes}`;
      const ordinal = ordinals.get(signature) || 0;
      ordinals.set(signature, ordinal + 1);
      records.push({ id: `session:${signature}|${ordinal}`, phone, date, time, bytes, kind: 'session' });
    }
    if (skipped) warnings.push(`${skipped} session(s) could not be dated or read and were excluded.`);
    if (!sessionCount && !/no (?:data|usage|records|history|activity)|haven.t used|nothing to show/i.test(all.slice(start).join(' '))) warnings.push('No readable sessions found. This is not evidence of zero usage.');
    return { phone, name, records, skipped, sessionCount, warnings, oldest: records.length ? records.reduce((d, r) => r.date < d ? r.date : d, today) : null };
  }
  function emptyState() {
    return { version: 1, settings: { cycleDay: 15, allowanceGb: null, timezone: 'Australia/Sydney' }, services: [], records: [], captures: {}, coverage: [], lineCounters: [], bills: [], pool: null, status: null };
  }
  function mergeCapture(state, capture) {
    const next = structuredClone(state);
    const at = capture.capturedAt;
    if (capture.home) {
      const previous = new Map(next.services.map(s => [s.phone, s]));
      // Home is the authoritative roster for this account; never combine accounts.
      const roster = capture.home.services.map(s => ({ ...previous.get(s.phone), phone: s.phone, name: s.name }));
      const changedAccount = previous.size && !roster.some(s => previous.has(s.phone));
      if (changedAccount) throw new Error('This looks like a different account. Use a separate browser profile for its data.');
      next.services = roster;
      const balances = capture.home.services.map(s => s.remainingBytes);
      if (balances.length && balances.every(b => b !== null && b === balances[0])) {
        next.pool = { remainingBytes: balances[0], capturedAt: at, source: 'Vodafone balance', reportedDate: capture.today };
      }
    }
    for (const line of capture.lines || []) {
      if (!next.services.some(s => s.phone === line.phone)) next.services.push({ phone: line.phone, name: line.name });
      if (line.source === 'api' && line.range && !line.skipped) {
        // A fresh API date window replaces older copies, including rounded DOM
        // captures. Otherwise the two sources would count the same traffic twice.
        next.records = next.records.filter(r => r.phone !== line.phone || r.date < line.range.start || r.date >= line.range.end || r.kind === 'bill');
        next.coverage ||= [];
        next.coverage = next.coverage.filter(r => !(r.phone === line.phone && r.start === line.range.start && r.end === line.range.end));
        next.coverage.push({ phone: line.phone, ...line.range, source: 'api', capturedAt: at });
      }
      const records = new Map(next.records.map(r => [r.id, r]));
      for (const record of line.records) records.set(record.id, record);
      next.records = [...records.values()];
      next.captures[line.phone] = { capturedAt: at, count: line.records.length, exhausted: line.exhausted, oldest: line.oldest, skipped: line.skipped, warnings: line.warnings, source: line.source || 'page' };
    }
    next.lastSync = at;
    next.status = { running: false, message: capture.errors?.length ? `Synced with ${capture.errors.length} issue(s).` : 'Sync complete.', errors: capture.errors || [] };
    return next;
  }
  function dailyRows(state, start, end, phones) {
    const selected = phones || state.services.map(s => s.phone);
    const records = state.records.filter(r => selected.includes(r.phone) && r.date >= start && r.date < end);
    const groups = new Map();
    for (const r of records) {
      const key = `${r.phone}|${r.date}`;
      if (!groups.has(key)) groups.set(key, { sessions: 0, bill: null, count: 0 });
      const group = groups.get(key);
      if (r.kind === 'bill') group.bill = r.bytes;
      else { group.sessions += r.bytes; group.count++; }
    }
    const result = [];
    for (let date = start; date < end; date = addDays(date, 1)) {
      const values = {};
      for (const phone of selected) {
        const group = groups.get(`${phone}|${date}`);
        const billCovers = state.bills.some(b => b.phones.includes(phone) && date >= b.start && date < b.end);
        const apiCovers = state.coverage?.some(r => r.phone === phone && date >= r.start && date < r.end);
        values[phone] = group ? (group.bill ?? group.sessions) : billCovers || apiCovers ? 0 : null;
      }
      const known = Object.values(values).filter(v => v !== null);
      result.push({ date, values, bytes: known.length ? known.reduce((a, b) => a + b, 0) : null });
    }
    return result;
  }
  function totalsFor(state, start, end, phones) {
    const selected = phones || state.services.map(s => s.phone);
    const rows = dailyRows(state, start, end, selected);
    const lines = selected.map(phone => {
      const values = rows.map(row => row.values[phone]).filter(v => v !== null);
      const bill = state.bills.find(b => b.start === start && b.end === end && b.totals?.[phone] !== undefined);
      const counter = state.counterPeriod?.start === start && state.counterPeriod?.end === end ? state.lineCounters?.find(c => c.phone === phone && c.usedBytes !== null) : null;
      const api = state.records.some(r => r.phone === phone && r.kind === 'api' && r.date >= start && r.date < end) || state.coverage?.some(r => r.phone === phone && r.start < end && r.end > start);
      return { phone, bytes: counter ? counter.usedBytes : bill ? bill.totals[phone] : values.length ? values.reduce((a, b) => a + b, 0) : null, source: counter ? 'Current API counter' : bill ? 'Bill total' : api ? 'My Vodafone API history' : 'Captured sessions', knownDays: values.length };
    });
    const known = lines.filter(l => l.bytes !== null);
    return { rows, lines, bytes: known.length ? known.reduce((sum, l) => sum + l.bytes, 0) : null };
  }
  function poolUsage(state, cycle) {
    const pool = state.pool, allowance = state.settings.allowanceGb;
    if (!pool || !allowance || !pool.reportedDate || pool.reportedDate < cycle.start || pool.reportedDate >= cycle.end) return null;
    if (pool.remainingBytes > allowance * GB) return null;
    const usedBytes = Number.isFinite(pool.usedBytes) ? pool.usedBytes : allowance * GB - pool.remainingBytes;
    return { usedBytes, remainingBytes: pool.remainingBytes, percent: usedBytes / (allowance * GB) * 100, capturedAt: pool.capturedAt };
  }
  const api = { GB, clean, linesOf, iso, addDays, validDate, todayISO, cycleFor, cycleProgress, toBytes, formatData, phoneId, displayPhone, dateHeading, parseHome, parseUsage, emptyState, mergeCapture, dailyRows, totalsFor, poolUsage };
  root.VodaCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
