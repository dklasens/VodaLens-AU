const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./build-edge-prototype.cjs');
const projectRoot = path.join(__dirname, '..');
const root = path.join(projectRoot, 'output/edge-prototype');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
for (const file of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
  console.log(`Syntax OK: ${file}`);
}
for (const html of ['popup.html', 'dashboard.html']) {
  const text = fs.readFileSync(path.join(root, html), 'utf8');
  for (const match of text.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (!match[1].startsWith('https://') && !fs.existsSync(path.join(root, match[1]))) throw Error(`Missing ${match[1]} in ${html}`);
  }
}
if (manifest.host_permissions?.length || manifest.permissions.some(p => !['activeTab', 'scripting', 'storage'].includes(p))) throw Error('Unexpected permissions');
console.log('Manifest permissions and local asset references OK.');
const project = JSON.parse(fs.readFileSync(path.join(projectRoot, 'project.json')));
if (project.streams.map(s => s.id).join(',') !== 'edge,ios,android') throw Error('The three required platform streams must be present.');
for (const stream of project.streams) if (!fs.existsSync(path.join(projectRoot, stream.path, 'README.md'))) throw Error(`Missing stream contract: ${stream.id}`);
const bridgeRoot = path.join(projectRoot, 'apps/edge/session-bridge');
const bridge = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'manifest.json')));
if (JSON.stringify(bridge.permissions) !== '["storage"]' || JSON.stringify(bridge.host_permissions) !== '["https://my.vodafone.com.au/*","http://127.0.0.1/*"]') throw Error('Unexpected session-bridge access.');
if (bridge.web_accessible_resources || bridge.externally_connectable || fs.existsSync(path.join(bridgeRoot, 'local-config.json'))) throw Error('The bridge source must not expose a private backend configuration.');
for (const script of bridge.content_scripts) {
  if (JSON.stringify(script.matches) !== '["https://my.vodafone.com.au/*"]' || script.run_at !== 'document_start') throw Error('Unexpected page-hook scope.');
  for (const file of script.js) if (!fs.existsSync(path.join(bridgeRoot, file))) throw Error(`Missing bridge script: ${file}`);
}
if (fs.existsSync(path.join(root, 'private'))) throw Error('The default prototype build retained private data.');
for (const directory of ['packages', 'services/api/src', 'scripts', 'apps/edge/session-bridge']) {
  for (const file of fs.readdirSync(path.join(projectRoot, directory), { recursive: true }).filter(f => /\.c?js$/.test(f))) new vm.Script(fs.readFileSync(path.join(projectRoot, directory, file), 'utf8'), { filename: `${directory}/${file}` });
}
const specification = JSON.parse(fs.readFileSync(path.join(projectRoot, 'services/api/openapi.json')));
if (specification.openapi !== '3.1.0') throw Error('Missing unified API contract.');
console.log('Shared packages, backend syntax, stream contracts and OpenAPI document OK.');
