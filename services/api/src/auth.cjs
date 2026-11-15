'use strict';
const { MyVodafoneSession } = require('./session.cjs');
const { VodafoneAuth } = require('./oauth.cjs');
function createVodafoneAuth(options) {
  return options.config.authMethod === 'registered-oauth' ? new VodafoneAuth(options) : new MyVodafoneSession(options);
}
module.exports = { createVodafoneAuth };
