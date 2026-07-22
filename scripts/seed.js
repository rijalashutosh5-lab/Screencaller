// Seed a demo account + sample voice forms so a fresh container has something
// to log into and a shareable link ready immediately.
//
//   npm run seed
//
// Idempotent on the demo email: re-running won't create duplicate accounts,
// but it will (re)create the sample forms if they're missing.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../server/db');

const DEMO = {
  email: 'demo@example.com',
  password: 'demo1234',
  name: 'Demo Creator',
  orgName: 'Demo Org'
};

const SAMPLE_FORMS = [
  {
    title: 'Product feedback — voice survey',
    questions: [
      'In your own words, what did you use the product for this week?',
      'What was the single most frustrating moment, if any?',
      'If you could change one thing, what would it be?'
    ]
  },
  {
    title: 'Backend Engineer — first-round screen',
    questions: [
      'Walk us through a system you designed and what you would change today.',
      'Tell us about a production incident you helped resolve.',
      'Why are you interested in this role?'
    ]
  }
];

function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function uniqueCode() {
  let code;
  do { code = genCode(); } while (db.prepare('SELECT 1 FROM forms WHERE code = ?').get(code));
  return code;
}

function ensureRecruiter() {
  const existing = db.prepare('SELECT * FROM recruiters WHERE email = ?').get(DEMO.email);
  if (existing) return existing;

  const orgId = crypto.randomUUID();
  const recruiterId = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
    .run(orgId, DEMO.orgName, now);
  db.prepare(
    'INSERT INTO recruiters (id, org_id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(recruiterId, orgId, DEMO.email, bcrypt.hashSync(DEMO.password, 10), DEMO.name, now);
  return db.prepare('SELECT * FROM recruiters WHERE id = ?').get(recruiterId);
}

function ensureForm(recruiter, spec) {
  const existing = db
    .prepare('SELECT * FROM forms WHERE org_id = ? AND title = ?')
    .get(recruiter.org_id, spec.title);
  if (existing) return existing;

  const formId = crypto.randomUUID();
  const code = uniqueCode();
  const now = Date.now();
  db.prepare(
    'INSERT INTO forms (id, org_id, created_by, title, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(formId, recruiter.org_id, recruiter.id, spec.title, code, 'published', now);

  const insertQ = db.prepare('INSERT INTO questions (id, form_id, order_index, text) VALUES (?, ?, ?, ?)');
  spec.questions.forEach((text, i) => insertQ.run(crypto.randomUUID(), formId, i, text));
  return db.prepare('SELECT * FROM forms WHERE id = ?').get(formId);
}

const recruiter = ensureRecruiter();
const forms = SAMPLE_FORMS.map(spec => ensureForm(recruiter, spec));

console.log('\nSeeded demo data:');
console.log(`  Login:    ${DEMO.email} / ${DEMO.password}`);
console.log('  Forms:');
for (const f of forms) {
  console.log(`    - ${f.title}  →  /apply.html?code=${f.code}`);
}
console.log('\nStart the server and sign in at /index.html\n');
