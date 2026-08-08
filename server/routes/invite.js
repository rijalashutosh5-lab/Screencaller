const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { transcribe } = require('../transcribe');
const { tierConfig } = require('../tiers');
const { parseQuestion, INPUT_TYPES } = require('../questions');
const { encodeValue } = require('../answerValue');
const { validateSubmission } = require('../validation');

// Public: respondents reach these routes with a share code and no account.
const router = express.Router();

const uploadRoot = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

// Browsers disagree on recording format — Chrome/Firefox emit audio/webm,
// iOS Safari emits audio/mp4. Store the file with the extension that matches
// what was actually recorded so playback serves the right Content-Type.
const EXT_BY_MIME = { 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg' };
function extForFile(file) {
  const base = (file.mimetype || '').split(';')[0].trim();
  return EXT_BY_MIME[base] || '.webm';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${extForFile(file)}`)
  }),
  // A form now posts many text fields alongside its recordings, so bound those
  // too rather than only capping file size.
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per answer
    files: 50,
    fields: 300,
    fieldSize: 256 * 1024
  }
});

// Multer rejections (oversized upload, too many fields) would otherwise fall
// through to Express's HTML error page. Respondents get JSON like every other
// failure on this route.
function receiveUpload(req, res, next) {
  upload.any()(req, res, err => {
    if (!err) return next();
    cleanupFiles(req.files);
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(413).json({
      error: tooBig
        ? 'One of your recordings is too large. Keep answers under 25MB.'
        : 'That submission was too large to accept.'
    });
  });
}

// Uploaded files are written to disk before the handler runs, so every failure
// path has to clean up after itself or rejected submissions accumulate.
function cleanupFiles(files) {
  for (const file of files || []) fs.unlink(file.path, () => {});
}

function loadPublicForm(code) {
  return db
    .prepare(
      `SELECT f.*, o.tier FROM forms f
         JOIN organizations o ON o.id = f.org_id
        WHERE f.code = ? AND f.status = 'published'`
    )
    .get(String(code || '').toUpperCase());
}

function liveQuestions(formId) {
  return db
    .prepare('SELECT * FROM questions WHERE form_id = ? AND deleted_at IS NULL ORDER BY order_index')
    .all(formId)
    .map(parseQuestion);
}

// Whether this form is still collecting. Closing intake never hides or deletes
// anything already submitted — the owner keeps every response they have.
function intakeState(form) {
  const cfg = tierConfig(form.tier);
  if (cfg.readOnly) {
    return { open: false, message: 'This is a sample form and is not collecting responses.' };
  }
  if (cfg.maxResponsesPerForm === Infinity) return { open: true, remaining: null };
  const { c } = db.prepare('SELECT COUNT(*) c FROM responses WHERE form_id = ?').get(form.id);
  if (c >= cfg.maxResponsesPerForm) {
    return { open: false, message: 'This form is no longer accepting responses.' };
  }
  return { open: true, remaining: cfg.maxResponsesPerForm - c };
}

// Reject a closed form before multer runs, so a submission to a form that has
// stopped collecting never buffers 25MB of audio to disk first.
function resolveIntake(req, res, next) {
  const form = loadPublicForm(req.params.code);
  if (!form) return res.status(404).json({ error: 'No form found for that code' });
  const intake = intakeState(form);
  if (!intake.open) return res.status(403).json({ code: 'INTAKE_CLOSED', error: intake.message });
  req.form = form;
  next();
}

// Respondent loads a form by its share code — no auth required.
router.get('/:code', (req, res) => {
  const form = loadPublicForm(req.params.code);
  if (!form) return res.status(404).json({ error: 'No form found for that code' });

  const intake = intakeState(form);
  // 200 rather than 404: the page renders a "no longer accepting responses"
  // card, which is a different thing from a bad code.
  if (!intake.open) {
    return res.json({ id: form.id, title: form.title, intake: { open: false, message: intake.message } });
  }

  res.json({
    id: form.id,
    title: form.title,
    layout: form.layout || 'one_per_page',
    requireEmail: !!form.require_email,
    intake: { open: true },
    // Deliberately no org, creator, or code details.
    questions: liveQuestions(form.id).map(q => ({
      id: q.id,
      type: q.type,
      text: q.text,
      required: q.required,
      config: q.config
    }))
  });
});

// Respondent submits: one multipart request carrying the identity fields, an
// audio file per audio question (answer_<id>), and a JSON-encoded value per
// non-audio question (value_<id>).
router.post('/:code/submit', resolveIntake, receiveUpload, (req, res) => {
  const form = req.form;
  const questions = liveQuestions(form.id);
  const inputQuestions = questions.filter(q => INPUT_TYPES.has(q.type));
  // Consent is about being recorded, so only demand it when something is.
  const hasAudio = inputQuestions.some(q => q.type === 'audio');

  const result = validateSubmission({
    questions: inputQuestions,
    requireEmail: !!form.require_email,
    requireConsent: hasAudio,
    body: req.body || {},
    files: req.files || []
  });

  if (!result.ok) {
    cleanupFiles(req.files);
    return res.status(400).json({
      error: 'Some answers need attention',
      formErrors: result.formErrors,
      fieldErrors: result.fieldErrors
    });
  }

  // Discard any upload that doesn't correspond to an audio question on this
  // form — a stale question id, or a file posted against a text question.
  const audioIds = new Set(inputQuestions.filter(q => q.type === 'audio').map(q => q.id));
  const keptFiles = [];
  for (const file of req.files || []) {
    const match = /^answer_(.+)$/.exec(file.fieldname);
    if (match && audioIds.has(match[1])) keptFiles.push(file);
    else fs.unlink(file.path, () => {});
  }

  // ---- Synchronous from here through the inserts. Do not introduce an await. --
  // resolveIntake counted before multer spent many event-loop turns receiving
  // the upload, so two respondents at the cap boundary can both have passed it.
  // Re-checking here, with no await between the COUNT and the INSERT, is atomic
  // against other requests because DatabaseSync is synchronous and Node is
  // single-threaded. An await anywhere below silently reopens that race.
  const intake = intakeState(form);
  if (!intake.open) {
    cleanupFiles(keptFiles);
    return res.status(403).json({ code: 'INTAKE_CLOSED', error: intake.message });
  }

  const responseId = crypto.randomUUID();
  const now = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
  const filesByQuestion = new Map(keptFiles.map(f => [/^answer_(.+)$/.exec(f.fieldname)[1], f]));
  const audioAnswers = [];

  db.transaction(() => {
    db.prepare(
      `INSERT INTO responses (id, form_id, candidate_name, respondent_email, submitted_at, consent_given_at, consent_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      responseId, form.id, result.name, result.email || null, now,
      // Recorded server-side, never trusted from client state — and only
      // meaningful on a form that actually records.
      hasAudio ? now : null,
      hasAudio ? ip : null
    );

    const insertAnswer = db.prepare(
      `INSERT INTO answers (id, response_id, question_id, audio_path, value_json, transcript_status)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // One row per input question, including the ones left blank. Keeping the
    // grain fixed makes "skipped" explicit in exports and keeps question
    // numbering aligned with the form rather than with whatever was answered.
    for (const q of inputQuestions) {
      const answerId = crypto.randomUUID();
      if (q.type === 'audio') {
        const file = filesByQuestion.get(q.id);
        insertAnswer.run(answerId, responseId, q.id, file ? file.path : null, null, file ? 'pending' : null);
        if (file) audioAnswers.push({ id: answerId, path: file.path });
      } else {
        const value = result.values[q.id];
        insertAnswer.run(answerId, responseId, q.id, null, encodeValue(value === undefined ? null : value), null);
      }
    }
  });
  // ---- End of the synchronous block. ----------------------------------------

  // Only audio answers have anything to transcribe; running text through the
  // transcriber would stamp mock output over real answers.
  if (audioAnswers.length) transcribeAnswers(audioAnswers);

  res.json({ ok: true, responseId });
});

// Fire-and-forget: transcribe each saved recording and write the result back.
// Runs after the HTTP response so a slow transcriber never delays submission.
function transcribeAnswers(answers) {
  const setStatus = db.prepare('UPDATE answers SET transcript_status = ? WHERE id = ?');
  const setResult = db.prepare('UPDATE answers SET transcript = ?, transcript_status = ? WHERE id = ?');
  setImmediate(async () => {
    for (const answer of answers) {
      try {
        setStatus.run('processing', answer.id);
        const text = await transcribe(answer.path);
        setResult.run(text, 'done', answer.id);
      } catch (err) {
        setStatus.run('failed', answer.id);
        console.error(`Transcription failed for answer ${answer.id}:`, err.message);
      }
    }
  });
}

module.exports = router;
