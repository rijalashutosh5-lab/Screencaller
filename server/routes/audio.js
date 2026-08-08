const express = require('express');
const path = require('path');
const db = require('../db');

// Auth is applied at the mount point in server/index.js.
const router = express.Router();

router.get('/:answerId', (req, res) => {
  const row = db
    .prepare(
      `SELECT a.audio_path, f.org_id
       FROM answers a
       JOIN responses r ON r.id = a.response_id
       JOIN forms f ON f.id = r.form_id
       WHERE a.id = ?`
    )
    .get(req.params.answerId);

  // audio_path is NULL for every non-audio answer type, so the guard is not
  // just an ownership check — path.resolve(null) would throw.
  if (!row || !row.audio_path || row.org_id !== req.recruiter.orgId) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.resolve(row.audio_path), err => {
    // The row can outlive its file (retention cleanup, a lost volume). Answer
    // with JSON rather than falling through to Express's HTML error page.
    if (err && !res.headersSent) res.status(404).json({ error: 'Recording not found' });
  });
});

module.exports = router;
