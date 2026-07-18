const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { signToken } = require('../auth');

const router = express.Router();

router.post('/register', (req, res) => {
  const { email, password, name, orgName } = req.body || {};
  if (!email || !password || !name || !orgName) {
    return res.status(400).json({ error: 'email, password, name, and orgName are all required' });
  }
  const existing = db.prepare('SELECT id FROM recruiters WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const orgId = crypto.randomUUID();
  const recruiterId = crypto.randomUUID();
  const now = Date.now();
  const passwordHash = bcrypt.hashSync(password, 10);

  db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(orgId, orgName, now);
  db.prepare(
    'INSERT INTO recruiters (id, org_id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(recruiterId, orgId, email.toLowerCase(), passwordHash, name, now);

  const recruiter = { id: recruiterId, org_id: orgId, email: email.toLowerCase() };
  res.json({ token: signToken(recruiter), recruiter: { id: recruiterId, name, email, orgName } });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const recruiter = db.prepare('SELECT * FROM recruiters WHERE email = ?').get(email.toLowerCase());
  if (!recruiter || !bcrypt.compareSync(password, recruiter.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(recruiter.org_id);
  res.json({
    token: signToken(recruiter),
    recruiter: { id: recruiter.id, name: recruiter.name, email: recruiter.email, orgName: org.name }
  });
});

module.exports = router;
