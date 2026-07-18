const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');

const router = express.Router();

const uploadRoot = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.webm`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB per answer
});

// Candidate loads a form by its share code — no auth required
router.get('/:code', (req, res) => {
  const form = db
    .prepare("SELECT * FROM forms WHERE code = ? AND status = 'published'")
    .get(req.params.code.toUpperCase());
  if (!form) return res.status(404).json({ error: 'No form found for that code' });

  const questions = db
    .prepare('SELECT id, text FROM questions WHERE form_id = ? ORDER BY order_index')
    .all(form.id);

  res.json({ id: form.id, title: form.title, questions });
});

// Candidate submits: multipart form with candidateName, consent, and one audio
// file per question, fields named answer_<questionId>
router.post('/:code/submit', upload.any(), (req, res) => {
  const form = db
    .prepare("SELECT * FROM forms WHERE code = ? AND status = 'published'")
    .get(req.params.code.toUpperCase());
  if (!form) return res.status(404).json({ error: 'No form found for that code' });

  const candidateName = (req.body.candidateName || '').trim();
  const consent = req.body.consent === 'true';
  if (!candidateName) return res.status(400).json({ error: 'candidateName is required' });
  if (!consent) return res.status(400).json({ error: 'Consent is required before submitting' });
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one recorded answer is required' });
  }

  const questions = db.prepare('SELECT id FROM questions WHERE form_id = ?').all(form.id);
  const questionIds = new Set(questions.map(q => q.id));

  const responseId = crypto.randomUUID();
  const now = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

  db.prepare(
    'INSERT INTO responses (id, form_id, candidate_name, submitted_at, consent_given_at, consent_ip) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(responseId, form.id, candidateName, now, now, ip);

  const insertAnswer = db.prepare(
    'INSERT INTO answers (id, response_id, question_id, audio_path) VALUES (?, ?, ?, ?)'
  );

  let saved = 0;
  for (const file of req.files) {
    const match = /^answer_(.+)$/.exec(file.fieldname);
    const questionId = match ? match[1] : null;
    if (questionId && questionIds.has(questionId)) {
      insertAnswer.run(crypto.randomUUID(), responseId, questionId, file.path);
      saved++;
    } else {
      fs.unlink(file.path, () => {}); // discard anything that doesn't map to a real question
    }
  }

  if (saved === 0) {
    db.prepare('DELETE FROM responses WHERE id = ?').run(responseId);
    return res.status(400).json({ error: 'None of the submitted audio matched this form\'s questions' });
  }

  res.json({ ok: true, responseId });
});

module.exports = router;
