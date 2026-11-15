'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

test('bridge builds default to no research and rebuilding clears a previous opt-in', t => {
  const root = path.resolve(__dirname, '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vodalens-bridge-build-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const name of ['scripts/build-session-bridge.cjs', 'services/api/src/config.cjs', 'packages/backend-client/src/index.cjs']) {
    fs.mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(fixture, name));
  }
  fs.cpSync(path.join(root, 'apps/edge/session-bridge'), path.join(fixture, 'apps/edge/session-bridge'), { recursive: true });
  function build(flag) {
    const env = ['VODALENS_API_TOKEN=private-test-backend-credential-long-enough', 'VODALENS_VAULT_KEY=' + randomBytes(32).toString('base64'), 'ALLOWED_CLIENT_ORIGINS='];
    if (flag !== undefined) env.push('VODALENS_ENABLE_RENEWAL_RESEARCH=' + flag);
    fs.writeFileSync(path.join(fixture, '.env'), env.join('\n'));
    execFileSync(process.execPath, ['scripts/build-session-bridge.cjs'], { cwd: fixture, stdio: 'pipe' });
    const output = path.join(fixture, 'output/edge-session-bridge');
    return { config: JSON.parse(fs.readFileSync(path.join(output, 'local-config.json'))), relay: fs.readFileSync(path.join(output, 'relay.js'), 'utf8'), popup: fs.readFileSync(path.join(output, 'popup.html'), 'utf8') };
  }
  let result = build();
  assert.equal(result.config.renewalResearchEnabled, false);
  assert.match(result.relay, /const RESEARCH_ENABLED = false;/);
  assert.match(result.popup, /id="renewalResearch" hidden/);
  result = build('true');
  assert.equal(result.config.renewalResearchEnabled, true);
  assert.match(result.relay, /const RESEARCH_ENABLED = true;/);
  assert.doesNotMatch(result.popup, /id="renewalResearch" hidden/);
  result = build('false');
  assert.equal(result.config.renewalResearchEnabled, false);
  assert.match(result.relay, /const RESEARCH_ENABLED = false;/);
  assert.match(result.popup, /id="renewalResearch" hidden/);
});
