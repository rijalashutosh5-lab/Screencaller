// Question type registry + config validation.
//
// Everything type-specific about a question lives in the `config` JSON column,
// so adding a new question type is a change to this file plus a renderer — never
// a schema migration. `questions.text` is the question's label, and
// `questions.order_index` its order; both predate this file and keep their names.

// A `section` is both a heading and a page break (see forms.layout). It is the
// only type that never produces an answer row.
const TYPES = [
  'audio',
  'short_text',
  'paragraph',
  'multiple_choice',
  'checkboxes',
  'dropdown',
  'linear_scale',
  'date',
  'time',
  'section'
];

const INPUT_TYPES = new Set(TYPES.filter(t => t !== 'section'));
const CHOICE_TYPES = new Set(['multiple_choice', 'checkboxes', 'dropdown']);
// Types where an "Other…" escape hatch makes sense (single/multi select, but not
// a dropdown, which has no natural place to put the free-text box).
const OTHER_TYPES = new Set(['multiple_choice', 'checkboxes']);
// Types that accept a validation rule. Choice/scale/date/time are already
// constrained by their own shape.
const VALIDATABLE_TYPES = new Set(['short_text', 'paragraph']);

const VALIDATION_KINDS = new Set(['email', 'number', 'regex']);

// Guards against a pathological pattern being stored and then run against every
// submission. Rejected at save time so a respondent never hits it.
const MAX_PATTERN_LENGTH = 200;

class QuestionError extends Error {}

function fail(msg) {
  throw new QuestionError(msg);
}

function cleanString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Normalize the validation sub-object, or return undefined if there's no usable
// rule. Anything that doesn't apply to `type` is dropped rather than stored.
function normalizeValidation(type, raw, label) {
  if (!raw || typeof raw !== 'object' || !VALIDATABLE_TYPES.has(type)) return undefined;

  const out = {};
  const kind = cleanString(raw.kind);
  if (kind) {
    if (!VALIDATION_KINDS.has(kind)) fail(`"${label}": unknown validation kind "${kind}"`);
    out.kind = kind;
  }

  if (out.kind === 'number') {
    for (const key of ['min', 'max']) {
      if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
      const n = Number(raw[key]);
      if (!Number.isFinite(n)) fail(`"${label}": validation ${key} must be a number`);
      out[key] = n;
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
      fail(`"${label}": validation min must not exceed max`);
    }
  }

  if (out.kind === 'regex') {
    const pattern = cleanString(raw.pattern);
    if (!pattern) fail(`"${label}": a regex rule needs a pattern`);
    if (pattern.length > MAX_PATTERN_LENGTH) {
      fail(`"${label}": regex pattern is too long (max ${MAX_PATTERN_LENGTH} characters)`);
    }
    // Compile now so a broken pattern fails against the form's author, at save
    // time, instead of throwing on a respondent mid-submission.
    try {
      new RegExp(pattern);
    } catch (e) {
      fail(`"${label}": regex pattern is not valid (${e.message})`);
    }
    out.pattern = pattern;
  }

  const maxLength = raw.maxLength;
  if (maxLength !== undefined && maxLength !== null && maxLength !== '') {
    const n = Number(maxLength);
    if (!Number.isInteger(n) || n <= 0) fail(`"${label}": maxLength must be a positive integer`);
    out.maxLength = n;
  }

  const message = cleanString(raw.message);
  if (message) out.message = message;

  return Object.keys(out).length ? out : undefined;
}

// Build the type-specific config, dropping any key that doesn't apply so we never
// persist stale shape (e.g. options left over from a type change in the builder).
function normalizeConfig(type, raw, label) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const config = {};

  const help = cleanString(src.help);
  if (help) config.help = help;

  if (CHOICE_TYPES.has(type)) {
    const options = Array.isArray(src.options) ? src.options.map(cleanString).filter(Boolean) : [];
    if (!options.length) fail(`"${label}": ${type.replace('_', ' ')} needs at least one option`);
    if (new Set(options).size !== options.length) fail(`"${label}": options must be unique`);
    config.options = options;
    if (OTHER_TYPES.has(type) && src.allowOther) config.allowOther = true;
  }

  if (type === 'linear_scale') {
    const min = src.min === undefined || src.min === '' ? 1 : Number(src.min);
    const max = src.max === undefined || src.max === '' ? 5 : Number(src.max);
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      fail(`"${label}": scale min and max must be whole numbers`);
    }
    if (min >= max) fail(`"${label}": scale min must be less than max`);
    config.min = min;
    config.max = max;
    const minLabel = cleanString(src.minLabel);
    const maxLabel = cleanString(src.maxLabel);
    if (minLabel) config.minLabel = minLabel;
    if (maxLabel) config.maxLabel = maxLabel;
  }

  if (type === 'section') {
    const description = cleanString(src.description);
    if (description) config.description = description;
  }

  const validation = normalizeValidation(type, src.validation, label);
  if (validation) config.validation = validation;

  return config;
}

// Accepts either the legacy bare-string question or the rich object form.
// Returns a row-ready { type, text, required, config } with config already
// JSON-encoded. Throws QuestionError on anything invalid.
function normalizeQuestion(input) {
  // A bare string is the pre-question-types shape: a required audio question.
  const q = typeof input === 'string' ? { text: input, type: 'audio', required: true } : (input || {});

  const type = cleanString(q.type) || 'audio';
  if (!TYPES.includes(type)) fail(`Unknown question type "${type}"`);

  const text = cleanString(q.text);
  // A section with no heading is a bare page break, which is legitimate.
  if (!text && type !== 'section') fail('Every question needs text');

  const label = text || '(untitled section)';
  const config = normalizeConfig(type, q.config, label);

  return {
    type,
    text,
    // Sections are never answered, so they can't be required.
    required: type !== 'section' && (q.required === true || q.required === 1 || q.required === '1') ? 1 : 0,
    config: JSON.stringify(config)
  };
}

// Inflate a DB row for use by route handlers and renderers. `config` is NULL on
// every row that predates question types, so treat that as {}.
function parseQuestion(row) {
  let config = {};
  if (row.config) {
    try {
      config = JSON.parse(row.config) || {};
    } catch (e) {
      config = {};
    }
  }
  return {
    id: row.id,
    type: row.type || 'audio',
    text: row.text,
    required: !!row.required,
    orderIndex: row.order_index,
    config
  };
}

module.exports = {
  TYPES,
  INPUT_TYPES,
  CHOICE_TYPES,
  OTHER_TYPES,
  VALIDATABLE_TYPES,
  MAX_PATTERN_LENGTH,
  QuestionError,
  normalizeQuestion,
  parseQuestion
};
