/* Runs in an isolated extension world after the toolbar action is clicked. */
(() => {
  'use strict';
  if (location.origin !== 'https://my.vodafone.com.au') return;
  const C = globalThis.VodaCore;
  const text = () => document.body.innerText;
  const label = el => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const controls = () => [...document.querySelectorAll('button, [role="button"], [role="tab"], a')].filter(visible);
  const find = pattern => controls().find(el => pattern.test(label(el)));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cancelled = () => { if (globalThis.__vodaCancel) throw new Error('Sync stopped.'); };
  const progress = message => { chrome.runtime.sendMessage({ type: 'progress', message }).catch(() => {}); };
  async function waitFor(predicate, description, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      cancelled();
      const value = predicate();
      if (value) return value;
      await pause(200);
    }
    throw new Error(`Vodafone did not finish ${description}. Please try again.`);
  }
  function isLoading() {
    return [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(el => visible(el) && !/progress bar/i.test(label(el))) || /\nLoading\s*(?:\n|$)/i.test(text());
  }
  async function settledUsage() {
    await waitFor(() => /usage history/i.test(text()) && !isLoading(), 'loading usage');
    let previous = '', stable = 0;
    await waitFor(() => {
      const value = text().split(/usage history/i).at(-1);
      stable = value === previous ? stable + 1 : 0;
      previous = value;
      return stable >= 3 && !isLoading();
    }, 'loading the session list');
  }
  async function openHome() {
    if (C.parseHome(text())) return;
    const link = [...document.querySelectorAll('a')].find(el => {
      const url = new URL(el.href, location.href);
      return visible(el) && url.origin === location.origin && url.pathname === '/' && /^My Vodafone$/i.test(label(el));
    });
    if (!link) throw new Error('Open the My Vodafone home page, then use Sync all services.');
    link.click();
    await waitFor(() => C.parseHome(text()), 'loading your services');
  }
  function detailsButton(service) {
    const buttons = controls().filter(el => /^more details about /i.test(label(el)));
    for (const button of buttons) {
      for (let node = button.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
        const phones = [...node.innerText.matchAll(/\b0[45](?:[\s-]?\d){8}\b/g)].map(m => C.phoneId(m[0]));
        if (new Set(phones).size === 1 && phones[0] === service.phone) return button;
        if (new Set(phones).size > 1) break;
      }
    }
    const byName = buttons.filter(button => label(button).toLowerCase() === `more details about ${service.name}`.toLowerCase());
    return byName.length === 1 ? byName[0] : null;
  }
  async function collectLine(service, today, loadMore) {
    const tab = find(/^Usage$/i);
    if (!tab) throw new Error('Open the selected service’s Usage tab first.');
    if (tab.getAttribute('aria-selected') !== 'true') tab.click();
    await settledUsage();
    // Filter only the history list. No account settings or paid actions are touched.
    const data = find(/^Data$/i);
    if (data && data.getAttribute('aria-pressed') !== 'true') { data.click(); await settledUsage(); }
    let exhausted = false, loaded = 0;
    for (; loaded < (loadMore ? 120 : 0); loaded++) {
      cancelled();
      const more = find(/^Show more$/i);
      if (!more) { exhausted = true; break; }
      const before = C.parseUsage(text(), { today, ...service }).sessionCount;
      progress(`Loading ${C.displayPhone(service.phone)} · batch ${loaded + 1}`);
      more.click();
      await waitFor(() => !isLoading() && (C.parseUsage(text(), { today, ...service }).sessionCount > before || !find(/^Show more$/i)), 'loading more sessions');
      await settledUsage();
    }
    const parsed = C.parseUsage(text(), { today, ...service });
    parsed.exhausted = exhausted || !find(/^Show more$/i);
    if (!parsed.exhausted) parsed.warnings.push(loadMore ? 'The batch limit was reached. Sync again after loading a narrower date range.' : 'More sessions are available on Vodafone.');
    // Exhaustion is only for the range Vodafone displayed, not proof of full-cycle coverage.
    parsed.warnings.push('Totals cover captured records; Vodafone’s selected date range may be narrower than the billing cycle.');
    return parsed;
  }
  globalThis.VodaCollector = {
    async capture({ mode = 'all', loadMore = true, timezone = 'Australia/Sydney' } = {}) {
      globalThis.__vodaCancel = false;
      const today = C.todayISO(new Date(), timezone);
      const result = { today, capturedAt: new Date().toISOString(), lines: [], errors: [], home: null };
      if (mode === 'page' && !/usage history/i.test(text())) {
        const home = C.parseHome(text());
        if (!home) throw new Error('Open the My Vodafone home page or a service’s Usage tab.');
        result.home = home;
        return result;
      }
      if (mode === 'page') {
        const selected = C.parseUsage(text(), { today });
        result.lines.push(await collectLine({ phone: selected.phone, name: selected.name }, today, loadMore));
        return result;
      }
      await openHome();
      result.home = C.parseHome(text());
      for (const service of result.home.services) {
        cancelled();
        try {
          await openHome();
          const details = await waitFor(() => detailsButton(service), 'finding service details');
          progress(`Opening ${C.displayPhone(service.phone)}`);
          details.click();
          await waitFor(() => /usage/i.test(text()) && text().replace(/[\s-]/g, '').includes(service.phone) && !C.parseHome(text()), 'opening your service');
          const actual = [...text().split(/usage history|active services/i)[0].matchAll(/\b0[45](?:[\s-]?\d){8}\b/g)].map(m => C.phoneId(m[0]));
          if (actual.length && actual.at(-1) !== service.phone) throw new Error('The selected service changed.');
          result.lines.push(await collectLine(service, today, loadMore));
        } catch (error) {
          result.errors.push(`${C.displayPhone(service.phone)}: ${error.message}`);
        }
      }
      try { await openHome(); } catch { /* The capture remains useful if returning home fails. */ }
      return result;
    }
  };
})();
