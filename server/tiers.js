// Account tiers. An "account" is an organization — forms.org_id already scopes
// every query, so quotas count naturally from there.
//
// Tiers are provisioned manually (scripts/account.js); there is no self-serve
// upgrade path, and deliberately no billing.

const TIERS = {
  // View-only. Pre-seeded with sample forms and responses so prospects can
  // explore without touching real data. Rejects every write at the API level.
  demo: { label: 'Demo', readOnly: true, maxForms: 0, maxResponsesPerForm: 0 },
  free: { label: 'Free', readOnly: false, maxForms: 5, maxResponsesPerForm: 20 },
  full: { label: 'Full access', readOnly: false, maxForms: Infinity, maxResponsesPerForm: Infinity }
};

// Fail OPEN on an unknown or NULL tier: a bad value in the column should never
// lock a paying account out of its own data.
function tierConfig(tier) {
  return TIERS[tier] || TIERS.full;
}

module.exports = { TIERS, tierConfig };
