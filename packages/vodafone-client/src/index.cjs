/* Portable, read-only My Vodafone adapter. No browser DOM or token persistence. */
(function (root) {
  'use strict';
  const ORIGIN = 'https://dsapi.vodafone.com.au';
  const PATHS = Object.freeze({ history: '/tmf-api/usageManagement/v4/usage', consumption: '/tmf-api/usageConsumption/v4/queryUsageConsumption', plans: '/tpg-api/customerManagement/v1/customer/planDetails' });
  const dayAfter = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  function isDate(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  }
  function msisdn(value) {
    let result = String(value || '').replace(/[\s+-]/g, '');
    if (/^04\d{8}$/.test(result)) result = `61${result.slice(1)}`;
    if (!/^614\d{8}$/.test(result)) throw new Error('An Australian mobile service number is required.');
    return result;
  }
  const localPhone = value => `0${msisdn(value).slice(2)}`;
  function serviceRoster(data) {
    const accounts = data?.accountDetails?.accountDetail?.billingAccount;
    if (!Array.isArray(accounts)) throw new Error('Unexpected Vodafone account/service response.');
    const services = new Map();
    let skippedAssets = 0;
    const label = value => typeof value === 'string' ? value.trim().slice(0, 160) || null : null;
    for (const account of accounts) {
      if (!Array.isArray(account?.asset)) throw new Error('Unexpected Vodafone service asset list.');
      for (const asset of account.asset) {
        let phone;
        try { phone = localPhone(asset?.msisdn); } catch { skippedAssets++; continue; }
        const service = { phone, planName: label(asset.displayPlanName), accountType: label(asset.accountType), serviceType: label(asset.serviceType) };
        const previous = services.get(phone);
        if (previous && JSON.stringify(previous) !== JSON.stringify(service)) throw new Error('Vodafone returned conflicting details for a service.');
        services.set(phone, service);
      }
    }
    return { services: [...services.values()], skippedAssets };
  }
  function valueBytes(value) {
    if (!value || value.amount === null || value.amount === '' || value.amount === undefined) return null;
    const powers = { B: 0, BYTE: 0, BYTES: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
    const power = powers[String(value.units).trim().toUpperCase()];
    const amount = Number(value.amount);
    if (power === undefined || !Number.isFinite(amount) || amount < 0) return null;
    const bytes = Math.round(amount * 1024 ** power);
    return Number.isSafeInteger(bytes) ? bytes : null;
  }
  function historyRecords(data, phone, { start, end } = {}) {
    if (!Array.isArray(data)) throw new Error('Unexpected Vodafone history response.');
    if (!isDate(start) || !isDate(end) || end < start) throw new Error('A valid inclusive history date range is required.');
    phone = localPhone(phone);
    const records = [], ordinals = new Map();
    let skipped = 0, nonData = 0;
    for (const row of data) {
      if (String(row.usageType).toLowerCase() !== 'data') { nonData++; continue; }
      const amount = row.usageCharacteristic?.find(item => item.name === 'data-BYTES')?.value;
      const stamp = String(row.usageDate || '');
      const date = stamp.slice(0, 10);
      const bytes = typeof amount === 'string' && /^\d+$/.test(amount) ? Number(amount) : typeof amount === 'number' ? amount : null;
      if (!isDate(date) || date < start || date > end || bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) { skipped++; continue; }
      // Unzoned timestamps are carrier wall-clock values. Do not append Z or let
      // the handset's timezone move a session to another recorded day.
      const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stamp) ? stamp.slice(11, 19) : null;
      const signature = `${phone}|${stamp}|${bytes}`;
      const ordinal = ordinals.get(signature) || 0;
      ordinals.set(signature, ordinal + 1);
      records.push({ id: `api:${signature}|${ordinal}`, phone, date, time, bytes, kind: 'api', providerTimestamp: stamp });
    }
    return { phone, records, source: 'api', range: { start, end: dayAfter(end) }, exhausted: true, skipped, sessionCount: data.length, nonData, oldest: records.length ? records.reduce((d, r) => r.date < d ? r.date : d, end) : null, warnings: skipped ? [`${skipped} invalid or out-of-range data sessions excluded.`] : [] };
  }
  function buckets(data) {
    if (!data || !Array.isArray(data.usageConsumption)) throw new Error('Unexpected Vodafone consumption response.');
    return data.usageConsumption.flatMap(item => item.bucketRefOrValue || []);
  }
  function accountCounters(data) {
    return buckets(data).filter(bucket => bucket.usageType === 'Data Consumption Counter').map(bucket => ({
      phone: localPhone(bucket.id),
      usedBytes: valueBytes(bucket.bucketCounter?.find(counter => counter.counterType === 'used')?.value),
      // Counter allowances can disagree with the actual shared bundle. They are
      // deliberately not returned as a pool quota or summed across services.
      reportedEnd: bucket.validFor?.endDateTime || null
    }));
  }
  function sharedBuckets(responses) {
    const unique = new Map();
    for (const response of responses) for (const bucket of buckets(response)) {
      if (bucket.usageType === 'Data Consumption Counter') continue;
      const totalBytes = valueBytes(bucket.bucketCounter?.find(counter => counter.counterType === 'total')?.value);
      const usedBytes = valueBytes(bucket.bucketCounter?.find(counter => counter.counterType === 'used')?.value);
      const remainingBytes = valueBytes(bucket.remainingValue);
      const start = bucket.validFor?.startDateTime?.slice(0, 10), last = bucket.validFor?.endDateTime?.slice(0, 10);
      if (!bucket.id || totalBytes === null || !isDate(start) || !isDate(last)) continue;
      const result = { id: bucket.id, name: bucket.name, totalBytes, usedBytes, remainingBytes, start, end: dayAfter(last) };
      const key = `${bucket.id}|${start}|${last}`;
      const previous = unique.get(key);
      if (previous && (previous.totalBytes !== totalBytes || previous.usedBytes !== usedBytes || previous.remainingBytes !== remainingBytes)) throw new Error('Vodafone returned conflicting snapshots of the same shared data bucket. Sync again.');
      unique.set(key, result);
    }
    return [...unique.values()];
  }
  class VodafoneClient {
    constructor({ getAccessToken, fetchImpl = root.fetch, headers = {}, makeTraceId = () => root.crypto.randomUUID() } = {}) {
      if (typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function') throw new Error('Supply a token provider and fetch implementation.');
      this.getAccessToken = getAccessToken; this.fetchImpl = fetchImpl; this.makeTraceId = makeTraceId;
      // These are the observed web-app context headers; native client context
      // must be agreed with Vodafone before a distributed native integration.
      this.headers = { accept: 'application/json', brand: 'tpg', channel: 'oneapp-web', 'vf-project': 'ONEAPP', 'vf-api-version': 'v1', ...headers };
    }
    async read(path, params = {}, { signal } = {}) {
      if (!Object.values(PATHS).includes(path)) throw new Error('Unsupported read-only API path.');
      const url = new URL(path, ORIGIN);
      for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, String(value));
      let rejectedToken;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.getAccessToken({ forceRefresh: attempt === 1, ...(attempt === 1 ? { rejectedToken } : {}) });
        if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('Sign in to Vodafone to obtain an access token.');
        const trace = this.makeTraceId();
        const response = await this.fetchImpl(url.toString(), { method: 'GET', headers: { ...this.headers, 'ext-bp-id': trace, 'trace-transaction-id': trace, authorization: `Bearer ${token}` }, credentials: 'omit', redirect: 'error', signal: signal || AbortSignal.timeout(15000) });
        if (response.status === 401 && attempt === 0) { rejectedToken = token; continue; }
        if (!response.ok) {
          const error = new Error(response.status === 401 ? 'Vodafone sign-in has expired.' : response.status === 403 ? 'This Vodafone session is not permitted to access that resource.' : response.status === 429 ? 'Vodafone rate limit reached. Try again later.' : `Vodafone API returned HTTP ${response.status}.`);
          error.status = response.status; throw error;
        }
        return response.json();
      }
    }
    plans(options) { return this.read(PATHS.plans, {}, options); }
    consumption(phone, options) { return this.read(PATHS.consumption, { id: msisdn(phone) }, options); }
    counters(partyId, customerAccountNumber, options) {
      if (!partyId || !customerAccountNumber) throw new Error('Select a Vodafone customer account first.');
      return this.read(PATHS.consumption, { id: partyId, customerAccountNumber }, options);
    }
    history(phone, start, end, options) {
      if (!isDate(start) || !isDate(end) || end < start) throw new Error('Choose a valid history date range.');
      return this.read(PATHS.history, { id: msisdn(phone), startdate: start, enddate: end, eventtype: 'All' }, options);
    }
  }
  const api = { ORIGIN, PATHS, msisdn, localPhone, serviceRoster, valueBytes, historyRecords, accountCounters, sharedBuckets, VodafoneClient };
  root.VodaAPI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
