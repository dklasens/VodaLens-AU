'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseEnv } = require('node:util');
const { loadConfig } = require('../services/api/src/config.cjs');
const root = path.join(__dirname, '..'), source = path.join(root, 'apps/edge/session-bridge');
const envPath = path.join(root, '.env'), envText = fs.readFileSync(envPath, 'utf8');
const config = loadConfig(parseEnv(envText));
if (config.publicOrigin !== 'http://127.0.0.1:8766' || config.authMethod !== 'myvodafone-session') throw new Error('This personal development build requires My Vodafone session mode and http://127.0.0.1:8766.');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
const origin = `chrome-extension://${id}`;
if (!config.allowedOrigins.includes(origin)) {
  const value = [...config.allowedOrigins, origin].join(',');
  if (!/^ALLOWED_CLIENT_ORIGINS=.*$/m.test(envText)) throw new Error('Add ALLOWED_CLIENT_ORIGINS= to .env before building.');
  fs.writeFileSync(envPath, envText.replace(/^ALLOWED_CLIENT_ORIGINS=.*$/m, `ALLOWED_CLIENT_ORIGINS=${value}`), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}
const destination = path.join(root, 'output/edge-session-bridge');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
fs.chmodSync(destination, 0o700);
fs.cpSync(source, destination, { recursive: true });
fs.copyFileSync(path.join(root, 'packages/backend-client/src/index.cjs'), path.join(destination, 'backend-client.js'));
fs.writeFileSync(path.join(destination, 'local-config.json'), JSON.stringify({ backendOrigin: config.publicOrigin, backendToken: config.apiToken }), { mode: 0o600 });
fs.chmodSync(path.join(destination, 'local-config.json'), 0o600);
console.log(`Personal bridge built in output/edge-session-bridge. Extension ID: ${id}.`);
console.log('This ignored build contains your local backend credential. Restart the backend after its exact extension origin has been added to .env.');
