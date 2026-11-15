'use strict';
(() => {
  const C = globalThis.VodaCore;
  const $ = id => document.getElementById(id);
  const extension = !!globalThis.chrome?.storage?.local;
  const colours = ['#275d9b', '#25887d', '#8a60a7', '#bc7427', '#b65369'];
  let state, cycles = [], selectedCycle = null, selectedLine = 'all', cumulative = false, selectedDate = null;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateLabel = (date, year = false) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const sourceDate = value => value ? new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney', ...(value.includes('T') ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(value)) : 'Not captured yet';
  const cycleLabel = cycle => `${dateLabel(cycle.start)} – ${dateLabel(cycle.last, true)}`;
  const gb = (bytes, digits = 2) => `${(bytes / C.GB).toLocaleString('en-AU', { maximumFractionDigits: digits })} GB`;
  const amount = bytes => bytes > 0 && bytes < .01 * C.GB ? C.formatData(bytes) : gb(bytes);
  const colour = phone => colours[Math.max(0, state.services.findIndex(s => s.phone === phone)) % colours.length];
  async function request(message) {
    if (!extension) throw new Error('Load Voda Lens as an extension in Edge, then click its toolbar icon on My Vodafone to sync.');
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error);
    return response;
  }
  function showError(message) { $('error-status').textContent = message; $('error-status').hidden = !message; }
  function setMeter(id, percent) {
    const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
    $(id).querySelector('.meter-fill').style.width = `${value}%`;
    $(id).setAttribute('aria-valuenow', String(value));
    $(id).setAttribute('aria-valuetext', percent === null ? 'No captured data' : `${percent.toFixed(1)} percent`);
  }
  function makeCycles() {
    const current = C.cycleFor(C.todayISO(), state.settings.cycleDay);
    const map = new Map([[current.start, { ...current, current: true }]]);
    const previous = C.cycleFor(C.addDays(current.start, -1), state.settings.cycleDay);
    map.set(previous.start, { ...previous, current: false });
    for (const record of state.records) {
      const cycle = C.cycleFor(record.date, state.settings.cycleDay);
      if (!map.has(cycle.start)) map.set(cycle.start, { ...cycle, current: false });
    }
    // Preserve exact bill periods even if the user later edits their cycle day.
    for (const bill of state.bills) if (!map.has(bill.start)) map.set(bill.start, { start: bill.start, end: bill.end, last: C.addDays(bill.end, -1), days: (Date.parse(bill.end) - Date.parse(bill.start)) / 86400000, current: false });
    cycles = [...map.values()].sort((a, b) => b.start.localeCompare(a.start));
    if (!cycles.some(c => c.start === selectedCycle)) selectedCycle = current.start;
    $('cycle').innerHTML = cycles.map(c => `<option value="${c.start}"${c.start === selectedCycle ? ' selected' : ''}>${c.current ? 'Current · ' : ''}${escape(cycleLabel(c))}</option>`).join('');
  }
  function render() {
    makeCycles();
    const cycle = cycles.find(c => c.start === selectedCycle);
    const totals = C.totalsFor(state, cycle.start, cycle.end);
    const progress = C.cycleProgress(cycle);
    const pool = C.poolUsage(state, cycle);
    const quota = state.settings.allowanceGb;
    const used = pool ? pool.usedBytes : totals.bytes;
    const usagePercent = used !== null && quota ? used / (quota * C.GB) * 100 : null;
    const hasBill = state.bills.some(b => b.start === cycle.start && b.end === cycle.end);
    $('remaining').textContent = cycle.current && pool ? gb(pool.remainingBytes) : '—';
    $('remaining-context').textContent = cycle.current && pool ? `Of ${quota.toLocaleString('en-AU')} GB shared · Vodafone balance` : cycle.current ? 'Sync Vodafone to capture the shared balance' : 'Historical remaining balance not captured';
    $('used-label').textContent = pool ? 'Reported data used' : 'Recorded data used';
    $('used').textContent = used === null ? '—' : amount(used);
    $('used-context').textContent = pool ? `Balance snapshot · ${sourceDate(pool.capturedAt)}` : hasBill ? 'From billed service totals' : totals.bytes === null ? 'No line records captured for this cycle' : 'From captured sessions · coverage may be partial';
    $('days-left').textContent = cycle.current ? `${progress.daysLeft} days` : 'Complete';
    $('cycle-context').textContent = cycle.current ? `Day ${progress.day} of ${cycle.days} · resets ${dateLabel(cycle.end)}` : cycleLabel(cycle);
    $('pace-subtitle').textContent = `${cycleLabel(cycle)} · ${quota ? quota.toLocaleString('en-AU') + ' GB shared allowance' : 'Set your shared allowance in Cycle settings'}`;
    $('time-percent').textContent = `${progress.percent.toFixed(1)}%`;
    $('data-percent').textContent = usagePercent === null ? 'Not captured' : `${usagePercent > 0 && usagePercent < .1 ? '<0.1' : usagePercent.toFixed(1)}%${pool || hasBill ? '' : ' recorded'}`;
    $('data-meter-label').textContent = pool ? 'Shared data used · balance snapshot' : hasBill ? 'Billed data / current allowance' : 'Captured data / allowance';
    setMeter('time-meter', progress.percent);
    setMeter('data-meter', usagePercent);
    $('pace-status').textContent = !cycle.current ? 'Historical cycle' : pool ? 'Balance snapshot' : 'Sync needed';
    $('pace-note').textContent = pool ? 'Time advances through the cycle; data reflects the last Vodafone balance, which is rounded. Per-line sessions are shown below when captured.' : hasBill ? 'This comparison uses your current allowance. The bill confirms usage for the services it lists; it does not establish the historical shared allowance.' : 'Captured sessions are a lower bound, not a verified full-cycle total. Load all batches for the date range you need.';
    $('sync-time').textContent = state.lastSync ? `Last sync ${sourceDate(state.lastSync)}` : state.pool ? `Balance observed ${sourceDate(state.pool.capturedAt)}` : 'No browser sync yet';
    const running = state.status?.running;
    $('sync').disabled = !!running;
    $('sync').textContent = running ? 'Syncing…' : 'Sync Vodafone ↻';
    $('sync-status').hidden = !running;
    $('sync-status').textContent = state.status?.message || '';
    if (state.status?.errors?.length) showError(state.status.errors.join('\n'));
    $('line').innerHTML = '<option value="all">All lines</option>' + state.services.map(s => `<option value="${s.phone}"${selectedLine === s.phone ? ' selected' : ''}>${escape(C.displayPhone(s.phone))}</option>`).join('');
    $('legend').innerHTML = state.services.filter(s => selectedLine === 'all' || selectedLine === s.phone).map(s => `<span class="legend-item"><i class="swatch" style="background:${colour(s.phone)}"></i>${escape(C.displayPhone(s.phone))}</span>`).join('');
    renderChart(cycle);
    $('line-rows').innerHTML = totals.lines.map(line => {
      const service = state.services.find(s => s.phone === line.phone);
      const share = line.bytes === null || !totals.bytes ? null : line.bytes / totals.bytes * 100;
      const capture = state.captures[line.phone];
      const info = line.source === 'Current API counter' ? `API counter · ${sourceDate(state.pool?.capturedAt)}` : line.source === 'Bill total' ? 'PDF bill · daily summaries available' : capture ? `${sourceDate(capture.capturedAt)} · ${capture.source === 'api' ? 'API date window' : capture.exhausted ? 'displayed range loaded' : 'more batches available'}` : 'No browser capture yet';
      return `<tr><td><div class="service-title"><i class="swatch" style="background:${colour(line.phone)}"></i><strong>${escape(C.displayPhone(line.phone))}</strong></div><p class="small muted">${escape(service?.name || 'Mobile service')}</p></td><td><strong>${line.bytes === null ? '—' : amount(line.bytes)}</strong><p class="small muted">${line.bytes === null ? 'No record in this cycle' : line.source}</p></td><td class="share-cell"><span class="share-value">${share === null ? '—' : share.toFixed(1) + '%'}</span><div class="mini-meter"><div class="mini-fill" style="width:${share || 0}%;background:${colour(line.phone)}"></div></div></td><td><p class="small muted">${escape(info)}</p>${capture?.skipped ? `<p class="small">${capture.skipped} unreadable sessions excluded</p>` : ''}</td></tr>`;
    }).join('');
    $('allowance').value = quota ?? '';
    $('cycle-day').value = state.settings.cycleDay;
    $('source-note').textContent = state.records.some(r => r.kind === 'api') ? 'Source: My Vodafone API responses captured locally' : hasBill ? 'Source: Vodafone PDF bill + local captures' : 'Source: signed-in My Vodafone pages';
  }
  function renderChart(cycle) {
    const phones = selectedLine === 'all' ? state.services.map(s => s.phone) : [selectedLine];
    const rows = C.dailyRows(state, cycle.start, cycle.end, phones);
    const known = rows.filter(r => r.bytes !== null);
    $('chart-subtitle').textContent = `${cumulative ? 'Cumulative captured usage' : 'Vodafone’s recorded daily usage'} · ${cycleLabel(cycle)}`;
    if (!known.length) {
      $('chart').innerHTML = '<div class="empty-chart">No sessions captured for this cycle yet.<br>Sync Vodafone to bring in the per-line detail.</div>';
      $('chart-detail').textContent = '';
      return;
    }
    if (!rows.some(r => r.date === selectedDate && r.bytes !== null)) selectedDate = known.reduce((a, b) => a.bytes > b.bytes ? a : b).date;
    const running = Object.fromEntries(phones.map(p => [p, 0]));
    const plotted = rows.map(row => {
      const values = {};
      for (const phone of phones) {
        if (row.values[phone] !== null) running[phone] += row.values[phone];
        values[phone] = cumulative ? running[phone] : row.values[phone];
      }
      return { ...row, values, bytes: row.bytes === null ? null : Object.values(values).reduce((a, b) => a + (b || 0), 0) };
    });
    const width = 1000, height = 250, left = 52, right = 12, top = 20, bottom = 34;
    const chartHeight = height - top - bottom, chartWidth = width - left - right;
    const maxGb = Math.max(...plotted.map(r => (r.bytes || 0) / C.GB), .001);
    const rawStep = maxGb / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].find(v => v * magnitude >= rawStep) * magnitude;
    const max = Math.ceil(maxGb / step) * step;
    const y = value => top + chartHeight * (1 - value / C.GB / max);
    const slot = chartWidth / rows.length, barWidth = slot * .62;
    let svg = `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="usage-chart-title usage-chart-desc"><title id="usage-chart-title">${cumulative ? 'Cumulative' : 'Daily'} usage in GB by line</title><desc id="usage-chart-desc">${escape(cycleLabel(cycle))}. Select a day to inspect its values. Missing records are shown as gaps.</desc>`;
    for (let tick = 0; tick <= max + step * .01; tick += step) {
      const yy = y(tick * C.GB);
      svg += `<line class="grid" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text x="${left - 10}" y="${yy + 4}" text-anchor="end">${Number(tick.toPrecision(3))}</text>`;
    }
    svg += `<text x="${left}" y="11">GB</text>`;
    plotted.forEach((row, index) => {
      const x = left + slot * index + (slot - barWidth) / 2;
      let stack = 0;
      svg += `<g>`;
      for (const phone of phones) {
        const value = row.values[phone] || 0;
        if (row.bytes !== null && value > 0) svg += `<rect class="bar" x="${x}" y="${y(stack + value)}" width="${barWidth}" height="${Math.max(.2, value / C.GB / max * chartHeight)}" fill="${colour(phone)}"/>`;
        stack += value;
      }
      if (row.bytes === null) svg += `<circle cx="${x + barWidth / 2}" cy="${top + chartHeight}" r="1.6" fill="#b9c0ca"/>`;
      const summary = `${dateLabel(row.date)}: ${row.bytes === null ? 'no captured record' : gb(row.bytes)}`;
      svg += `<rect class="day-target" data-date="${row.date}" role="button" tabindex="0" aria-label="${escape(summary)}" aria-pressed="${row.date === selectedDate}" x="${left + slot * index}" y="${top}" width="${slot}" height="${chartHeight + 6}"><title>${escape(summary)}</title></rect>`;
      if (row.date === selectedDate) svg += `<line x1="${x}" x2="${x + barWidth}" y1="${top + chartHeight + 6}" y2="${top + chartHeight + 6}" stroke="#18212f" stroke-width="2" pointer-events="none"/>`;
      if (index === 0 || index === rows.length - 1 || index % 5 === 0) svg += `<text x="${left + slot * (index + .5)}" y="${height - 9}" text-anchor="middle">${dateLabel(row.date)}</text>`;
      svg += '</g>';
    });
    $('chart').innerHTML = svg + '</svg>';
    const select = date => { selectedDate = date; renderChart(cycle); };
    $('chart').querySelectorAll('[data-date]').forEach(mark => {
      mark.addEventListener('click', () => select(mark.dataset.date));
      mark.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(mark.dataset.date); } });
    });
    const row = plotted.find(r => r.date === selectedDate);
    $('chart-detail').innerHTML = `<strong>${dateLabel(selectedDate, true)}</strong>` + phones.map(phone => `<span>${escape(C.displayPhone(phone))}: <strong>${row.values[phone] === null ? 'No record' : gb(row.values[phone], 3)}</strong></span>`).join('');
  }
  $('settings-toggle').addEventListener('click', () => {
    const open = $('settings-panel').hidden;
    $('settings-panel').hidden = !open;
    $('settings-toggle').setAttribute('aria-expanded', String(open));
  });
  $('settings-panel').addEventListener('submit', async event => {
    event.preventDefault();
    const settings = { cycleDay: Number($('cycle-day').value), allowanceGb: Number($('allowance').value) };
    try {
      if (extension) state = (await request({ type: 'settings', settings })).state;
      else { state.settings = { ...state.settings, ...settings }; localStorage.setItem('voda-lens-preview', JSON.stringify(state)); }
      $('settings-panel').hidden = true; $('settings-toggle').setAttribute('aria-expanded', 'false'); selectedCycle = null; showError(''); render();
    } catch (error) { showError(error.message); }
  });
  $('cycle').addEventListener('change', event => { selectedCycle = event.target.value; selectedDate = null; render(); });
  $('line').addEventListener('change', event => { selectedLine = event.target.value; selectedDate = null; renderChart(cycles.find(c => c.start === selectedCycle)); $('legend').innerHTML = state.services.filter(s => selectedLine === 'all' || s.phone === selectedLine).map(s => `<span class="legend-item"><i class="swatch" style="background:${colour(s.phone)}"></i>${escape(C.displayPhone(s.phone))}</span>`).join(''); });
  for (const mode of ['daily', 'cumulative']) $(mode).addEventListener('click', () => {
    cumulative = mode === 'cumulative';
    for (const button of ['daily', 'cumulative']) { $(button).classList.toggle('selected', button === mode); $(button).setAttribute('aria-pressed', String(button === mode)); }
    renderChart(cycles.find(c => c.start === selectedCycle));
  });
  $('sync').addEventListener('click', async () => {
    showError('');
    try { state = (await request({ type: 'capture', mode: 'all', loadMore: true })).state; render(); }
    catch (error) { showError(error.message); }
  });
  $('export').addEventListener('click', () => {
    const cycle = cycles.find(c => c.start === selectedCycle);
    const phones = selectedLine === 'all' ? state.services.map(s => s.phone) : [selectedLine];
    const rows = C.dailyRows(state, cycle.start, cycle.end, phones);
    const csv = [['Date', ...phones.map(p => `${C.displayPhone(p)} (GB)`), 'Recorded total (GB)'], ...rows.map(row => [row.date, ...phones.map(p => row.values[p] === null ? '' : (row.values[p] / C.GB).toFixed(6)), row.bytes === null ? '' : (row.bytes / C.GB).toFixed(6)])].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `vodafone-daily-${cycle.start}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  (async () => {
    try {
      if (extension) {
        state = (await request({ type: 'getState' })).state;
        chrome.storage.onChanged.addListener(changes => { if (changes.state?.newValue) { state = changes.state.newValue; render(); } });
      } else {
        $('preview-banner').hidden = false;
        const saved = localStorage.getItem('voda-lens-preview');
        if (saved) state = JSON.parse(saved);
        else { const response = await fetch('private/initial.json'); state = response.ok ? await response.json() : C.emptyState(); }
      }
      render();
      setInterval(() => { if (state && !document.hidden) render(); }, 60000);
    } catch (error) { showError(`Could not load the local dashboard: ${error.message}`); }
  })();
})();
