'use strict';
// Only the accountDetails envelope has been observed so far. Reject generic
// success/empty responses without inventing an unverified account field map.
function hasAccountData(response) {
  const details = response?.accountDetails;
  const account = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  return Array.isArray(details) ? details.length > 0 && details.every(account) : account(details);
}
module.exports = { hasAccountData };
