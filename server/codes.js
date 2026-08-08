const crypto = require('crypto');
const db = require('./db');

// Ambiguous characters (0/O, 1/I/L) are left out so a code can be read aloud
// or copied off a screen without confusion.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 6;

function genCode() {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

// The share code is the only thing standing between a link and a form, so it
// has to be unique. Retry until it is.
function uniqueCode() {
  let code;
  do { code = genCode(); } while (db.prepare('SELECT 1 FROM forms WHERE code = ?').get(code));
  return code;
}

module.exports = { genCode, uniqueCode, ALPHABET, LENGTH };
