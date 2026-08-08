const test = require('node:test');
const assert = require('node:assert');
const { validateSubmission, isEmail, isRealDate, isRealTime } = require('../server/validation');
const { normalizeQuestion, parseQuestion } = require('../server/questions');

// Build a parsed question the way a route would after reading it back from SQLite.
function q(id, spec) {
  const row = normalizeQuestion(spec);
  return parseQuestion({ id, text: row.text, type: row.type, required: row.required, order_index: 0, config: row.config });
}

const submit = (questions, body, opts = {}) =>
  validateSubmission({ questions, requireEmail: true, body, files: [], ...opts });

test('email format is checked, and required by default', () => {
  assert.ok(isEmail('a@b.co'));
  assert.ok(!isEmail('notanemail'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail('a b@c.co'));

  const r = submit([], { candidateName: 'Ada', respondentEmail: 'notanemail' });
  assert.strictEqual(r.ok, false);
  assert.match(r.formErrors.respondentEmail, /valid email/i);
});

test('email can be made optional per form, but must still be valid if given', () => {
  const blank = submit([], { candidateName: 'Ada' }, { requireEmail: false });
  assert.strictEqual(blank.formErrors.respondentEmail, undefined);

  const bad = submit([], { candidateName: 'Ada', respondentEmail: 'nope' }, { requireEmail: false });
  assert.match(bad.formErrors.respondentEmail, /valid email/i);
});

test('consent is only demanded when the form actually records audio', () => {
  const textOnly = submit([], { candidateName: 'Ada', respondentEmail: 'a@b.co' });
  assert.strictEqual(textOnly.formErrors.consent, undefined);

  const withAudio = submit([], { candidateName: 'Ada', respondentEmail: 'a@b.co' }, { requireConsent: true });
  assert.match(withAudio.formErrors.consent, /consent/i);
});

test('a required question left blank is reported against its own id', () => {
  const question = q('q1', { text: 'Name?', type: 'short_text', required: true });
  const r = submit([question], { candidateName: 'Ada', respondentEmail: 'a@b.co', value_q1: JSON.stringify('  ') });
  assert.strictEqual(r.ok, false);
  assert.match(r.fieldErrors.q1, /required/i);
});

test('an optional question left blank is simply absent from values', () => {
  const question = q('q1', { text: 'Name?', type: 'short_text' });
  const r = submit([question], { candidateName: 'Ada', respondentEmail: 'a@b.co', value_q1: JSON.stringify('') });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.values.q1, undefined);
});

test('choice answers must be members of the option list', () => {
  const question = q('q1', { text: 'Pick', type: 'multiple_choice', config: { options: ['Yes', 'No'] } });
  const bad = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify('Maybe') });
  assert.match(bad.fieldErrors.q1, /from the list/i);

  const good = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify('Yes') });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.values.q1, 'Yes');
});

test('allowOther admits exactly one free-text answer', () => {
  const question = q('q1', {
    text: 'Pick', type: 'checkboxes', config: { options: ['Yes', 'No'], allowOther: true }
  });
  const one = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify(['Yes', 'Custom']) });
  assert.strictEqual(one.ok, true);
  assert.deepStrictEqual(one.values.q1, ['Yes', 'Custom']);

  const two = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify(['X', 'Y']) });
  assert.match(two.fieldErrors.q1, /only one/i);
});

test('checkboxes reject a non-array payload', () => {
  const question = q('q1', { text: 'Pick', type: 'checkboxes', config: { options: ['Yes'] } });
  const r = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify('Yes') });
  assert.match(r.fieldErrors.q1, /one or more/i);
});

test('linear scale must be a whole number inside the configured range', () => {
  const question = q('q1', { text: 'Rate', type: 'linear_scale', config: { min: 1, max: 5 } });
  const call = v => submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify(v) });

  assert.match(call(9).fieldErrors.q1, /between 1 and 5/);
  assert.match(call(0).fieldErrors.q1, /between 1 and 5/);
  assert.match(call(2.5).fieldErrors.q1, /rating/i);
  assert.strictEqual(call(3).values.q1, 3, 'a valid scale value stays numeric');
});

test('dates and times are validated as real clock/calendar values', () => {
  assert.ok(isRealDate('2026-02-28'));
  assert.ok(!isRealDate('2026-02-31'), 'shape alone is not enough');
  assert.ok(!isRealDate('26-02-28'));
  assert.ok(isRealTime('23:59'));
  assert.ok(!isRealTime('24:00'));

  const question = q('q1', { text: 'When', type: 'date' });
  const r = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify('2026-02-31') });
  assert.match(r.fieldErrors.q1, /valid date/i);
});

test('number validation enforces its range', () => {
  const question = q('q1', {
    text: 'Age', type: 'short_text', config: { validation: { kind: 'number', min: 0, max: 120 } }
  });
  const call = v => submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify(v) });
  assert.match(call('abc').fieldErrors.q1, /number/i);
  assert.match(call('999').fieldErrors.q1, /no more than 120/);
  assert.strictEqual(call('42').ok, true);
});

test('regex validation runs, and a custom message wins', () => {
  const question = q('q1', {
    text: 'Ref', type: 'short_text',
    config: { validation: { kind: 'regex', pattern: '^AB-\\d+$', message: 'Use the AB-123 format' } }
  });
  const bad = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify('XX-1') });
  assert.strictEqual(bad.fieldErrors.q1, 'Use the AB-123 format');
  assert.strictEqual(
    submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: JSON.stringify('AB-77') }).ok,
    true
  );
});

test('a required audio question needs an uploaded file', () => {
  const question = q('q1', { text: 'Say something', type: 'audio', required: true });
  const missing = validateSubmission({
    questions: [question], requireEmail: true, requireConsent: true,
    body: { candidateName: 'A', respondentEmail: 'a@b.co', consent: 'true' }, files: []
  });
  assert.match(missing.fieldErrors.q1, /record an answer/i);

  const present = validateSubmission({
    questions: [question], requireEmail: true, requireConsent: true,
    body: { candidateName: 'A', respondentEmail: 'a@b.co', consent: 'true' },
    files: [{ fieldname: 'answer_q1', path: '/tmp/x.webm' }]
  });
  assert.strictEqual(present.ok, true);
  assert.strictEqual(present.audioByQuestion.get('q1').path, '/tmp/x.webm');
});

test('sections are skipped entirely — they never produce an answer', () => {
  const section = q('s1', { text: 'About you', type: 'section' });
  const r = submit([section], { candidateName: 'A', respondentEmail: 'a@b.co' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.values, {});
});

test('malformed JSON in a value field is reported, not thrown', () => {
  const question = q('q1', { text: 'Name?', type: 'short_text' });
  const r = submit([question], { candidateName: 'A', respondentEmail: 'a@b.co', value_q1: '{not json' });
  assert.match(r.fieldErrors.q1, /could not be read/i);
});
