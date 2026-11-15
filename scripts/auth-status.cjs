'use strict';
const { loadConfig } = require('../services/api/src/config.cjs');
const { Store } = require('../services/api/src/store.cjs');
const { createVodafoneAuth } = require('../services/api/src/auth.cjs');
try {
  const config = loadConfig(), store = new Store({ filename: config.database, key: config.vaultKey });
  const auth = createVodafoneAuth({ config, store });
  console.log(JSON.stringify(auth.status(config.ownerId), null, 2));
  store.close();
} catch (error) { console.error(error.message); process.exitCode = 1; }
