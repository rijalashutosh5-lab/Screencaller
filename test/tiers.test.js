const test = require('node:test');
const assert = require('node:assert');
const { TIERS, tierConfig } = require('../server/tiers');
const { decodeValue, displayValue, isSkipped } = require('../server/answerValue');

test('tier limits match the published plans', () => {
  assert.strictEqual(TIERS.free.maxForms, 5);
  assert.strictEqual(TIERS.free.maxResponsesPerForm, 20);
  assert.strictEqual(TIERS.full.maxForms, Infinity);
  assert.strictEqual(TIERS.demo.readOnly, true);
  assert.strictEqual(TIERS.free.readOnly, false);
});

test('an unknown or NULL tier fails open to full access', () => {
  // A bad value in the column must never lock an account out of its own data.
  assert.strictEqual(tierConfig(null), TIERS.full);
  assert.strictEqual(tierConfig(undefined), TIERS.full);
  assert.strictEqual(tierConfig('enterprise'), TIERS.full);
  assert.strictEqual(tierConfig('demo'), TIERS.demo);
});

test('decodeValue round-trips scalars, arrays and numbers', () => {
  assert.strictEqual(decodeValue({ value_json: JSON.stringify('hi') }), 'hi');
  assert.strictEqual(decodeValue({ value_json: JSON.stringify(4) }), 4);
  assert.deepStrictEqual(decodeValue({ value_json: JSON.stringify(['a', 'b']) }), ['a', 'b']);
  assert.strictEqual(decodeValue({ value_json: null }), null, 'audio answers carry no value');
  assert.strictEqual(decodeValue({ value_json: '{bad' }), null, 'corrupt JSON degrades to null');
});

test('displayValue flattens for CSV and the dashboard', () => {
  assert.strictEqual(displayValue({ type: 'short_text' }, { value_json: JSON.stringify('Ada') }), 'Ada');
  assert.strictEqual(displayValue({ type: 'checkboxes' }, { value_json: JSON.stringify(['a', 'b']) }), 'a; b');
  assert.strictEqual(displayValue({ type: 'linear_scale' }, { value_json: JSON.stringify(3) }), '3');
  assert.strictEqual(
    displayValue({ type: 'audio' }, { audio_path: '/u/x.webm', transcript: 'spoken words' }),
    'spoken words',
    'an audio answer displays as its transcript'
  );
  assert.strictEqual(displayValue({ type: 'short_text' }, { value_json: null }), '');
});

test('isSkipped distinguishes a blank answer from a real one', () => {
  assert.ok(isSkipped({ type: 'short_text' }, { value_json: null }));
  assert.ok(isSkipped({ type: 'short_text' }, { value_json: JSON.stringify('   ') }));
  assert.ok(isSkipped({ type: 'checkboxes' }, { value_json: JSON.stringify([]) }));
  assert.ok(isSkipped({ type: 'audio' }, { audio_path: null }));
  assert.ok(!isSkipped({ type: 'audio' }, { audio_path: '/u/x.webm' }));
  assert.ok(!isSkipped({ type: 'linear_scale' }, { value_json: JSON.stringify(0) }), '0 is a real answer');
});
