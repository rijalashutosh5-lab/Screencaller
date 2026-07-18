const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/:answerId', requireAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT a.audio_path, f.org_id
       FROM answers a
       JOIN responses r ON r.id = a.response_id
       JOIN forms f ON f.id = r.form_id
       WHERE a.id = ?`
    )
    .get(req.params.answerId);

  if (!row || row.org_id !== req.recruiter.orgId) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.resolve(row.audio_path));
});

module.exports = router;
