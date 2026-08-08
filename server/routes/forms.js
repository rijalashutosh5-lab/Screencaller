const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');
const { tierConfig } = require('../tiers');
const { normalizeQuestion, parseQuestion, QuestionError } = require('../questions');
const { decodeValue } = require('../answerValue');
const { uniqueCode } = require('../codes');

// Auth + tier enforcement are applied at the mount point in server/index.js.
const router = express.Router();

// Every read and write goes through this, so org scoping is stated once.
function ownedForm(req, id) {
  return db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(id, req.recruiter.orgId);
}

function answerCountFor(questionId) {
  return db.prepare('SELECT COUNT(*) c FROM answers WHERE question_id = ?').get(questionId).c;
}

// Resolve the project a new form belongs to. An explicit projectId must belong
// to the caller's org; otherwise fall back to (and lazily create) the org's
// "General" project so a form is never orphaned.
function resolveProjectId(recruiter, projectId) {
  if (projectId) {
    const p = db.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ?').get(projectId, recruiter.orgId);
    return p ? p.id : null;
  }
  const general = db
    .prepare("SELECT id FROM projects WHERE org_id = ? AND name = 'General' LIMIT 1")
    .get(recruiter.orgId);
  if (general) return general.id;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO projects (id, org_id, created_by, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, recruiter.orgId, recruiter.id, 'General', Date.now());
  return id;
}

const LAYOUTS = new Set(['one_per_page', 'sectioned']);

// Shared shape validation for POST and PUT. Throws QuestionError on bad input.
function normalizeFormBody(body) {
  const title = String((body && body.title) || '').trim();
  const questions = body && body.questions;
  if (!title) throw new QuestionError('A form needs a title');
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new QuestionError('A form needs at least one question');
  }
  const normalized = questions.map(q => {
    const row = normalizeQuestion(q);
    // Carry the client's id through so PUT can tell an edit from an insert.
    row.id = q && typeof q === 'object' && q.id ? String(q.id) : null;
    return row;
  });
  if (!normalized.some(q => q.type !== 'section')) {
    throw new QuestionError('A form needs at least one question that is not a section');
  }
  return {
    title,
    questions: normalized,
    requireEmail: body.requireEmail === false || body.requireEmail === 0 ? 0 : 1,
    layout: LAYOUTS.has(body.layout) ? body.layout : 'sectioned'
  };
}

// Free accounts cap how many forms an org may hold. Enforced here rather than
// in the UI so hitting the API directly can't bypass it. Not applied to PUT —
// editing an existing form doesn't consume a slot.
function enforceFormLimit(req, res, next) {
  const { maxForms } = tierConfig(req.recruiter.tier);
  if (maxForms === Infinity) return next();
  const { c: used } = db.prepare('SELECT COUNT(*) c FROM forms WHERE org_id = ?').get(req.recruiter.orgId);
  if (used >= maxForms) {
    return res.status(403).json({
      code: 'FORM_LIMIT',
      used,
      limit: maxForms,
      error: `Your plan includes ${maxForms} form${maxForms === 1 ? '' : 's'}. Delete one to make room.`
    });
  }
  next();
}

// Create a form with its questions
router.post('/', enforceFormLimit, (req, res) => {
  let spec;
  try {
    spec = normalizeFormBody(req.body || {});
  } catch (e) {
    if (e instanceof QuestionError) return res.status(400).json({ error: e.message });
    throw e;
  }

  const resolvedProjectId = resolveProjectId(req.recruiter, (req.body || {}).projectId);
  if (!resolvedProjectId) return res.status(400).json({ error: 'Project not found' });

  const formId = crypto.randomUUID();
  const now = Date.now();
  const code = uniqueCode();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO forms (id, org_id, project_id, created_by, title, code, status, created_at, require_email, layout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      formId, req.recruiter.orgId, resolvedProjectId, req.recruiter.id,
      spec.title, code, 'published', now, spec.requireEmail, spec.layout
    );

    const insertQ = db.prepare(
      'INSERT INTO questions (id, form_id, order_index, text, type, required, config) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // order_index is assigned from the filtered position, so it stays dense —
    // page grouping on the respondent side depends on contiguous ordering.
    spec.questions.forEach((q, i) => {
      insertQ.run(crypto.randomUUID(), formId, i, q.text, q.type, q.required, q.config);
    });
  });

  res.json({ id: formId, code, projectId: resolvedProjectId });
});

// List this org's forms, optionally scoped to a single project (?projectId=)
router.get('/', (req, res) => {
  const { projectId } = req.query;
  const forms = projectId
    ? db.prepare('SELECT * FROM forms WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC')
        .all(req.recruiter.orgId, projectId)
    : db.prepare('SELECT * FROM forms WHERE org_id = ? ORDER BY created_at DESC')
        .all(req.recruiter.orgId);

  const { maxResponsesPerForm } = tierConfig(req.recruiter.tier);
  // Sections are page breaks, not questions, and soft-deleted questions are
  // gone from the respondent's view — neither belongs in the count.
  const countQuestions = db.prepare(
    "SELECT COUNT(*) c FROM questions WHERE form_id = ? AND type != 'section' AND deleted_at IS NULL"
  );
  const countResponses = db.prepare('SELECT COUNT(*) c FROM responses WHERE form_id = ?');

  const withCounts = forms.map(f => ({
    ...f,
    questionCount: countQuestions.get(f.id).c,
    responseCount: countResponses.get(f.id).c,
    // null means uncapped; the dashboard renders "18 of 20" only when set.
    responseLimit: maxResponsesPerForm === Infinity ? null : maxResponsesPerForm
  }));
  res.json(withCounts);
});

// Fetch one form + its questions (must belong to caller's org)
router.get('/:id', (req, res) => {
  const form = ownedForm(req, req.params.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const questions = db
    .prepare('SELECT * FROM questions WHERE form_id = ? AND deleted_at IS NULL ORDER BY order_index')
    .all(form.id)
    .map(row => ({
      ...parseQuestion(row),
      // The builder disables the type picker once a question has been answered,
      // because the stored value encoding wouldn't match a new type.
      answerCount: answerCountFor(row.id)
    }));

  res.json({ ...form, questions });
});

// Replace a form's title, settings, and question set.
router.put('/:id', (req, res) => {
  const form = ownedForm(req, req.params.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  let spec;
  try {
    spec = normalizeFormBody(req.body || {});
  } catch (e) {
    if (e instanceof QuestionError) return res.status(400).json({ error: e.message });
    throw e;
  }

  const existing = db
    .prepare('SELECT id, type FROM questions WHERE form_id = ? AND deleted_at IS NULL')
    .all(form.id);
  const existingById = new Map(existing.map(q => [q.id, q]));

  // An id we don't recognise would otherwise silently create a duplicate, or
  // let one form write to another's question. Reject it.
  const unknown = spec.questions.filter(q => q.id && !existingById.has(q.id));
  if (unknown.length) {
    return res.status(400).json({ error: 'One or more questions do not belong to this form' });
  }

  // Changing a question's type after it has answers would orphan their stored
  // encoding — an audio answer under a question now claiming to be a scale is
  // unrenderable. Check every conflict before writing anything.
  const typeConflicts = spec.questions
    .filter(q => q.id && existingById.get(q.id).type !== q.type && answerCountFor(q.id) > 0)
    .map(q => q.id);
  if (typeConflicts.length) {
    return res.status(409).json({
      code: 'TYPE_LOCKED',
      questionIds: typeConflicts,
      error: 'These questions already have answers, so their type cannot change. Remove them and add new ones instead.'
    });
  }

  const keptIds = new Set(spec.questions.filter(q => q.id).map(q => q.id));

  db.transaction(() => {
    db.prepare('UPDATE forms SET title = ?, require_email = ?, layout = ? WHERE id = ?')
      .run(spec.title, spec.requireEmail, spec.layout, form.id);

    const update = db.prepare(
      'UPDATE questions SET text = ?, type = ?, required = ?, config = ?, order_index = ? WHERE id = ?'
    );
    const insert = db.prepare(
      'INSERT INTO questions (id, form_id, order_index, text, type, required, config) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    spec.questions.forEach((q, i) => {
      if (q.id) update.run(q.text, q.type, q.required, q.config, i, q.id);
      else insert.run(crypto.randomUUID(), form.id, i, q.text, q.type, q.required, q.config);
    });

    // A question dropped from the payload is only really deleted if nobody has
    // answered it. Otherwise it's soft-deleted: it disappears from the form but
    // still joins for the dashboard and export, so history never orphans.
    const softDelete = db.prepare('UPDATE questions SET deleted_at = ? WHERE id = ?');
    const hardDelete = db.prepare('DELETE FROM questions WHERE id = ?');
    const now = Date.now();
    for (const prev of existing) {
      if (keptIds.has(prev.id)) continue;
      if (answerCountFor(prev.id) > 0) softDelete.run(now, prev.id);
      else hardDelete.run(prev.id);
    }
  });

  res.json({ id: form.id, code: form.code });
});

// Delete a form and everything under it, including the recordings on disk.
router.delete('/:id', (req, res) => {
  const form = ownedForm(req, req.params.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  // Read the paths before the rows go, or the audio is orphaned on disk.
  const paths = db
    .prepare(
      `SELECT a.audio_path FROM answers a
         JOIN responses r ON r.id = a.response_id
        WHERE r.form_id = ? AND a.audio_path IS NOT NULL`
    )
    .all(form.id)
    .map(r => r.audio_path);

  db.transaction(() => {
    db.prepare('DELETE FROM answers WHERE response_id IN (SELECT id FROM responses WHERE form_id = ?)').run(form.id);
    db.prepare('DELETE FROM responses WHERE form_id = ?').run(form.id);
    db.prepare('DELETE FROM questions WHERE form_id = ?').run(form.id);
    db.prepare('DELETE FROM forms WHERE id = ?').run(form.id);
  });

  // Only once the rows are safely gone.
  for (const p of paths) fs.unlink(p, () => {});
  res.json({ ok: true, deleted: form.id });
});

// List responses for a form, with answers
router.get('/:id/responses', (req, res) => {
  const form = ownedForm(req, req.params.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const responses = db
    .prepare('SELECT * FROM responses WHERE form_id = ? ORDER BY submitted_at DESC')
    .all(form.id);

  // Deliberately NOT filtered by deleted_at: a soft-deleted question must still
  // render for responses that were submitted while it was live.
  const getAnswers = db.prepare(`
    SELECT a.id, a.question_id, a.audio_path, a.value_json, a.transcript, a.transcript_status,
           q.text as question_text, q.type as question_type, q.order_index
    FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.response_id = ? ORDER BY q.order_index
  `);

  const result = responses.map(r => ({
    ...r,
    answers: getAnswers.all(r.id).map(a => ({
      id: a.id,
      questionId: a.question_id,
      questionText: a.question_text,
      type: a.question_type,
      // Only audio answers have something to stream.
      audioUrl: a.audio_path ? `/api/audio/${a.id}` : null,
      value: decodeValue(a),
      transcript: a.transcript,
      transcriptStatus: a.transcript_status
    }))
  }));

  res.json(result);
});

// Delete a single response. Nested under the form so org scoping comes free
// from the lookup above rather than needing its own join.
router.delete('/:id/responses/:responseId', (req, res) => {
  const form = ownedForm(req, req.params.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const response = db
    .prepare('SELECT id FROM responses WHERE id = ? AND form_id = ?')
    .get(req.params.responseId, form.id);
  if (!response) return res.status(404).json({ error: 'Response not found' });

  const paths = db
    .prepare('SELECT audio_path FROM answers WHERE response_id = ? AND audio_path IS NOT NULL')
    .all(response.id)
    .map(r => r.audio_path);

  db.transaction(() => {
    db.prepare('DELETE FROM answers WHERE response_id = ?').run(response.id);
    db.prepare('DELETE FROM responses WHERE id = ?').run(response.id);
  });

  for (const p of paths) fs.unlink(p, () => {});
  res.json({ ok: true, deleted: response.id });
});

module.exports = router;
