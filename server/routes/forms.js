const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function genCode() {
  // 6-char human-typeable code, avoids ambiguous chars
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

// Create a form with its questions
router.post('/', (req, res) => {
  const { title, questions } = req.body || {};
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'title and a non-empty questions array are required' });
  }
  const formId = crypto.randomUUID();
  const now = Date.now();
  let code;
  do { code = genCode(); } while (db.prepare('SELECT 1 FROM forms WHERE code = ?').get(code));

  db.prepare(
    'INSERT INTO forms (id, org_id, created_by, title, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(formId, req.recruiter.orgId, req.recruiter.id, title, code, 'published', now);

  const insertQ = db.prepare('INSERT INTO questions (id, form_id, order_index, text) VALUES (?, ?, ?, ?)');
  questions.forEach((text, i) => {
    if (text && text.trim()) insertQ.run(crypto.randomUUID(), formId, i, text.trim());
  });

  res.json({ id: formId, code });
});

// List this org's forms
router.get('/', (req, res) => {
  const forms = db
    .prepare('SELECT * FROM forms WHERE org_id = ? ORDER BY created_at DESC')
    .all(req.recruiter.orgId);
  const withCounts = forms.map(f => {
    const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE form_id = ?').get(f.id).c;
    const responseCount = db.prepare('SELECT COUNT(*) c FROM responses WHERE form_id = ?').get(f.id).c;
    return { ...f, questionCount, responseCount };
  });
  res.json(withCounts);
});

// Fetch one form + its questions (must belong to caller's org)
router.get('/:id', (req, res) => {
  const form = db
    .prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.recruiter.orgId);
  if (!form) return res.status(404).json({ error: 'Form not found' });
  const questions = db
    .prepare('SELECT * FROM questions WHERE form_id = ? ORDER BY order_index')
    .all(form.id);
  res.json({ ...form, questions });
});

// List responses for a form, with answers
router.get('/:id/responses', (req, res) => {
  const form = db
    .prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.recruiter.orgId);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const responses = db
    .prepare('SELECT * FROM responses WHERE form_id = ? ORDER BY submitted_at DESC')
    .all(form.id);

  const getAnswers = db.prepare(`
    SELECT a.id, a.question_id, a.transcript, a.transcript_status,
           q.text as question_text, q.order_index
    FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.response_id = ? ORDER BY q.order_index
  `);

  const result = responses.map(r => ({
    ...r,
    answers: getAnswers.all(r.id).map(a => ({
      id: a.id,
      questionText: a.question_text,
      audioUrl: `/api/audio/${a.id}`,
      transcript: a.transcript,
      transcriptStatus: a.transcript_status
    }))
  }));

  res.json(result);
});

module.exports = router;
