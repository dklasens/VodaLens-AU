'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = path.join(root, 'apps/edge/prototype');
const destination = path.join(root, 'output/edge-prototype');
fs.mkdirSync(destination, { recursive: true });
// The authoritative capture lives in local-data, never in this generated tree.
// A later public build must not retain a private seed from an earlier build.
fs.rmSync(path.join(destination, 'private'), { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
fs.copyFileSync(path.join(root, 'packages/domain/src/index.cjs'), path.join(destination, 'core.js'));
fs.copyFileSync(path.join(root, 'packages/vodafone-client/src/index.cjs'), path.join(destination, 'api.js'));
const seed = path.join(root, 'local-data/vodafone-capture.json');
if (process.argv.includes('--with-private-data') && fs.existsSync(seed)) {
  fs.mkdirSync(path.join(destination, 'private'), { recursive: true });
  fs.copyFileSync(seed, path.join(destination, 'private/initial.json'));
}
console.log('Built the preserved Edge prototype in output/edge-prototype. The standalone Android app is maintained separately in apps/android.');
