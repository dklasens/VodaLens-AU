'use strict';
const { loadConfig } = require('./config.cjs');
const { Store } = require('./store.cjs');
const { createVodafoneAuth } = require('./auth.cjs');
const { createApplication } = require('./app.cjs');
const { RenewalResearch } = require('./renewal-research.cjs');
try {
  const config = loadConfig(), store = new Store({ filename: config.database, key: config.vaultKey });
  const auth = createVodafoneAuth({ config, store });
  const research = new RenewalResearch({ config, store });
  const server = createApplication({ config, store, auth, research });
  server.listen(config.port, config.host, () => {
    console.log(`VodaLens API listening on ${config.host}:${config.port}.`);
    console.log(config.authMethod === 'myvodafone-session' ? 'Connect your signed-in My Vodafone browser session. No client registration is required.' : 'Registered OAuth is selected; live authorization proof is required.');
  });
  const close = () => { server.close(() => { store.close(); process.exit(0); }); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  server.on('error', () => { console.error('The API listener could not start. Check the configured interface and port.'); store.close(); process.exitCode = 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
