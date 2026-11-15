'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { armRenewalResearch } = require('../services/api/src/renewal-research.cjs');
if (!process.argv.includes('--arm')) {
  console.log(fs.readFileSync(path.join(__dirname, '../docs/auth/renewal-probe-plan.json'), 'utf8'));
} else {
  // Execute only after the user explicitly approves the exact experiment.
  console.log(JSON.stringify(armRenewalResearch(), null, 2));
}
