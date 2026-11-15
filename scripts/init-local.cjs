'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const destination = path.join(__dirname, '../.env');
if (fs.existsSync(destination)) { console.log('.env already exists; no values were replaced.'); process.exit(0); }
let template = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
template = template.replace(/^VODALENS_API_TOKEN=$/m, `VODALENS_API_TOKEN=${randomBytes(32).toString('base64url')}`).replace(/^VODALENS_VAULT_KEY=$/m, `VODALENS_VAULT_KEY=${randomBytes(32).toString('base64')}`);
fs.writeFileSync(destination, template, { mode: 0o600, flag: 'wx' });
console.log('Created .env with local backend keys. No secrets were printed; Vodafone registration remains unconfigured.');
