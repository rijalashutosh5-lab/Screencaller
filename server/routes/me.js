const express = require('express');
const db = require('../db');
const { tierConfig } = require('../tiers');

const router = express.Router();

// The signed-in account: who it is, what its plan allows, and how much of that
// it has used. The dashboard reads this to surface limits before a write is
// rejected ("4 of 5 forms used") and to hide controls a demo account can't use.
// Mounted behind requireAuth in server/index.js.
router.get('/', (req, res) => {
  const cfg = tierConfig(req.recruiter.tier);
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.recruiter.orgId);
  const { c: formsUsed } = db
    .prepare('SELECT COUNT(*) c FROM forms WHERE org_id = ?')
    .get(req.recruiter.orgId);

  res.json({
    email: req.recruiter.email,
    name: req.recruiter.name,
    orgName: org ? org.name : null,
    tier: req.recruiter.tier,
    label: cfg.label,
    readOnly: cfg.readOnly,
    limits: {
      // JSON has no Infinity — null means "no cap".
      maxForms: cfg.maxForms === Infinity ? null : cfg.maxForms,
      maxResponsesPerForm: cfg.maxResponsesPerForm === Infinity ? null : cfg.maxResponsesPerForm
    },
    usage: { forms: formsUsed }
  });
});

module.exports = router;
