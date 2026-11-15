'use strict';
const { VodaLensClient } = require('../packages/backend-client/src/index.cjs');
const client = new VodaLensClient({ baseUrl: 'http://127.0.0.1:8766', getSessionToken: () => process.env.VODALENS_API_TOKEN });
client.request('/v1/research/vodafone/renewal-probe').then(status => console.log(JSON.stringify(status, null, 2))).catch(error => { console.error(error.code || 'Unable to read the local research status.'); process.exitCode = 1; });
