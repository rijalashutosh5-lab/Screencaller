const test = require('node:test');
const assert = require('node:assert');
const { normalizeQuestion, parseQuestion, QuestionError, INPUT_TYPES } = require('../server/questions');

const configOf = q => JSON.parse(q.config);

test('a bare string is the legacy shape: a required audio question', () => {
  const q = normalizeQuestion('Tell us about yourself');
  assert.strictEqual(q.type, 'audio');
  assert.strictEqual(q.text, 'Tell us about yourself');
  assert.strictEqual(q.required, 1);
});

test('required coerces from booleans, 1, and "1"', () => {
  assert.strictEqual(normalizeQuestion({ text: 'a', required: true }).required, 1);
  assert.strictEqual(normalizeQuestion({ text: 'a', required: 1 }).required, 1);
  assert.strictEqual(normalizeQuestion({ text: 'a', required: '1' }).required, 1);
  assert.strictEqual(normalizeQuestion({ text: 'a', required: false }).required, 0);
  assert.strictEqual(normalizeQuestion({ text: 'a' }).required, 0);
});

test('unknown types and blank text are rejected', () => {
  assert.throws(() => normalizeQuestion({ text: 'a', type: 'grid' }), QuestionError);
  assert.throws(() => normalizeQuestion({ text: '   ', type: 'short_text' }), QuestionError);
});

test('a section may have no heading — that is a bare page break', () => {
  const q = normalizeQuestion({ text: '', type: 'section' });
  assert.strictEqual(q.type, 'section');
  assert.strictEqual(q.required, 0, 'a section is never answerable, so never required');
  assert.ok(!INPUT_TYPES.has('section'));
});

test('choice types need at least one non-blank, unique option', () => {
  assert.throws(() => normalizeQuestion({ text: 'q', type: 'dropdown', config: { options: [] } }), QuestionError);
  assert.throws(() => normalizeQuestion({ text: 'q', type: 'dropdown', config: { options: ['  ', ''] } }), QuestionError);
  assert.throws(
    () => normalizeQuestion({ text: 'q', type: 'checkboxes', config: { options: ['a', 'a'] } }),
    QuestionError
  );
  const ok = normalizeQuestion({ text: 'q', type: 'checkboxes', config: { options: [' Yes ', 'No'] } });
  assert.deepStrictEqual(configOf(ok).options, ['Yes', 'No']);
});

test('allowOther applies to multiple choice and checkboxes, not dropdown', () => {
  const mc = normalizeQuestion({ text: 'q', type: 'multiple_choice', config: { options: ['a'], allowOther: true } });
  assert.strictEqual(configOf(mc).allowOther, true);
  const dd = normalizeQuestion({ text: 'q', type: 'dropdown', config: { options: ['a'], allowOther: true } });
  assert.strictEqual(configOf(dd).allowOther, undefined);
});

test('linear scale defaults to 1..5 and requires min < max', () => {
  assert.deepStrictEqual(
    { ...configOf(normalizeQuestion({ text: 'q', type: 'linear_scale' })) },
    { min: 1, max: 5 }
  );
  assert.throws(() => normalizeQuestion({ text: 'q', type: 'linear_scale', config: { min: 5, max: 5 } }), QuestionError);
  assert.throws(() => normalizeQuestion({ text: 'q', type: 'linear_scale', config: { min: 1.5, max: 4 } }), QuestionError);
});

test('a regex rule must compile and stay within the length cap', () => {
  assert.throws(
    () => normalizeQuestion({ text: 'q', type: 'short_text', config: { validation: { kind: 'regex', pattern: '([a-z' } } }),
    QuestionError,
    'a non-compiling pattern must be rejected at save time, not at submit time'
  );
  assert.throws(
    () => normalizeQuestion({
      text: 'q', type: 'short_text', config: { validation: { kind: 'regex', pattern: 'a'.repeat(201) } }
    }),
    QuestionError
  );
  const ok = normalizeQuestion({
    text: 'q', type: 'short_text', config: { validation: { kind: 'regex', pattern: '^AB-\\d+$' } }
  });
  assert.strictEqual(configOf(ok).validation.pattern, '^AB-\\d+$');
});

test('config keys that do not apply to the type are dropped', () => {
  // Options left behind by a type change in the builder must not persist.
  const q = normalizeQuestion({ text: 'q', type: 'short_text', config: { options: ['a', 'b'], min: 2 } });
  assert.deepStrictEqual(configOf(q), {});
});

test('validation is ignored on types that are already shape-constrained', () => {
  const q = normalizeQuestion({
    text: 'q', type: 'date', config: { validation: { kind: 'email' } }
  });
  assert.strictEqual(configOf(q).validation, undefined);
});

test('parseQuestion treats a NULL config as empty — every legacy row has one', () => {
  const parsed = parseQuestion({ id: 'x', form_id: 'f', text: 'Q', type: null, required: 0, order_index: 0, config: null });
  assert.deepStrictEqual(parsed.config, {});
  assert.strictEqual(parsed.type, 'audio', 'a row predating types is an audio question');
  assert.strictEqual(parsed.required, false);
});

test('parseQuestion survives corrupt JSON rather than throwing', () => {
  const parsed = parseQuestion({ id: 'x', text: 'Q', type: 'short_text', config: '{not json' });
  assert.deepStrictEqual(parsed.config, {});
});
