// The single place `answers.value_json` is encoded, decoded, and flattened.
//
// Answers are stored one row per input question, with the value JSON-encoded so
// multi-select arrays and numeric scales survive the round trip intact. Audio
// answers carry NULL here — their payload is the file at `answers.audio_path`.
//
// Choice answers deliberately store option *labels*, not option ids: that keeps
// historical responses self-describing, so renaming or deleting an option can
// never orphan or corrupt an answer that was already submitted.

// Decode a stored value back to its JS form. Returns null for audio answers,
// skipped questions, and anything unparseable.
function decodeValue(answer) {
  if (!answer || answer.value_json == null) return null;
  try {
    const v = JSON.parse(answer.value_json);
    return v === undefined ? null : v;
  } catch (e) {
    return null;
  }
}

function encodeValue(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// True when the respondent left this question blank.
function isSkipped(question, answer) {
  if (!answer) return true;
  if (question.type === 'audio') return !answer.audio_path;
  const v = decodeValue(answer);
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

// Flatten to a human-readable string, for CSV export and the dashboard.
// Audio answers render as their transcript, which is the only text they have.
function displayValue(question, answer) {
  if (!answer) return '';
  if (question.type === 'audio') return answer.transcript || '';
  const v = decodeValue(answer);
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('; ');
  return String(v);
}

module.exports = { decodeValue, encodeValue, isSkipped, displayValue };
