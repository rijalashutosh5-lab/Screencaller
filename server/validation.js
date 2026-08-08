// Submission validation. Pure functions, no DB and no Express — the route hands
// in the form's own question rows and the parsed request, and gets back either
// canonical values ready to insert or a per-question error map.
//
// The respondent page mirrors these rules for instant feedback, but this is the
// gate: everything is re-checked here against the form's stored config, because
// a client can post whatever it likes.

const { INPUT_TYPES, CHOICE_TYPES } = require('./questions');

// Deliberately conservative: one @, a dot in the domain, no whitespace. The goal
// is catching typos, not adjudicating RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

function isBlank(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === '';
}

// A real calendar date, not just the right shape — rejects 2026-02-31.
function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isRealTime(value) {
  if (!TIME_RE.test(value)) return false;
  const [h, min] = value.split(':').map(Number);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

// Apply the optional per-question validation rule to an already non-blank string.
function checkRule(rule, value) {
  if (!rule) return null;
  const custom = rule.message || null;

  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    return custom || `Keep this under ${rule.maxLength} characters`;
  }
  if (rule.kind === 'email' && !isEmail(value)) {
    return custom || 'Enter a valid email address';
  }
  if (rule.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return custom || 'Enter a number';
    if (rule.min !== undefined && n < rule.min) return custom || `Enter a number of at least ${rule.min}`;
    if (rule.max !== undefined && n > rule.max) return custom || `Enter a number no more than ${rule.max}`;
  }
  if (rule.kind === 'regex' && rule.pattern) {
    // Safe to compile unguarded: normalizeQuestion() already rejected any
    // pattern that doesn't compile or exceeds the length cap.
    if (!new RegExp(rule.pattern).test(value)) {
      return custom || 'This does not match the expected format';
    }
  }
  return null;
}

// Validate one non-audio question's decoded value. Returns an error string or
// null, and reports the canonical value via `out`.
function checkValue(question, value, out) {
  const cfg = question.config || {};

  if (question.type === 'checkboxes') {
    if (!Array.isArray(value)) return 'Select one or more options';
    const picked = value.map(v => String(v).trim()).filter(Boolean);
    const options = cfg.options || [];
    const strangers = picked.filter(v => !options.includes(v));
    if (strangers.length && !cfg.allowOther) return 'Select an option from the list';
    // With "Other" enabled, at most one free-text answer is meaningful.
    if (strangers.length > 1) return 'Only one "Other" answer is allowed';
    out.value = picked;
    return null;
  }

  if (CHOICE_TYPES.has(question.type)) {
    const picked = String(value).trim();
    const options = cfg.options || [];
    if (!options.includes(picked) && !cfg.allowOther) return 'Select an option from the list';
    out.value = picked;
    return null;
  }

  if (question.type === 'linear_scale') {
    const n = Number(value);
    const min = cfg.min ?? 1;
    const max = cfg.max ?? 5;
    if (!Number.isInteger(n)) return 'Pick a rating';
    if (n < min || n > max) return `Pick a rating between ${min} and ${max}`;
    out.value = n;
    return null;
  }

  if (question.type === 'date') {
    const s = String(value).trim();
    if (!isRealDate(s)) return 'Enter a valid date';
    out.value = s;
    return null;
  }

  if (question.type === 'time') {
    const s = String(value).trim();
    if (!isRealTime(s)) return 'Enter a valid time';
    out.value = s;
    return null;
  }

  // short_text / paragraph
  const s = String(value);
  const ruleError = checkRule(cfg.validation, s.trim());
  if (ruleError) return ruleError;
  out.value = s.trim();
  return null;
}

// questions: parsed rows (parseQuestion), sections and soft-deleted already removed.
// body:      req.body — respondentEmail, candidateName, consent, value_<qid> JSON.
// files:     req.files — multer entries with fieldname answer_<qid>.
//
// Returns { ok, formErrors, fieldErrors, values, email, name, audioByQuestion }.
function validateSubmission({ questions, requireEmail, requireConsent, body = {}, files = [] }) {
  const formErrors = {};
  const fieldErrors = {};
  const values = {};

  const name = String(body.candidateName || '').trim();
  if (!name) formErrors.candidateName = 'Enter your name';

  const email = String(body.respondentEmail || '').trim();
  if (requireEmail && !email) {
    formErrors.respondentEmail = 'Enter your email address';
  } else if (email && !isEmail(email)) {
    formErrors.respondentEmail = 'Enter a valid email address';
  }

  // Consent is only meaningful when something is actually being recorded.
  if (requireConsent && body.consent !== 'true') {
    formErrors.consent = 'Consent is required before submitting';
  }

  const audioByQuestion = new Map();
  for (const file of files) {
    const match = /^answer_(.+)$/.exec(file.fieldname);
    if (match) audioByQuestion.set(match[1], file);
  }

  for (const q of questions) {
    if (!INPUT_TYPES.has(q.type)) continue;

    if (q.type === 'audio') {
      const file = audioByQuestion.get(q.id);
      if (!file && q.required) fieldErrors[q.id] = 'Record an answer for this question';
      continue;
    }

    const raw = body[`value_${q.id}`];
    if (raw === undefined) {
      if (q.required) fieldErrors[q.id] = 'This question is required';
      continue;
    }

    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch (e) {
      fieldErrors[q.id] = 'That answer could not be read';
      continue;
    }

    if (isBlank(decoded)) {
      if (q.required) fieldErrors[q.id] = 'This question is required';
      continue;
    }

    const out = {};
    const error = checkValue(q, decoded, out);
    if (error) fieldErrors[q.id] = error;
    else values[q.id] = out.value;
  }

  return {
    ok: Object.keys(formErrors).length === 0 && Object.keys(fieldErrors).length === 0,
    formErrors,
    fieldErrors,
    values,
    email,
    name,
    audioByQuestion
  };
}

module.exports = { validateSubmission, isEmail, isRealDate, isRealTime, EMAIL_RE };
