const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const rawDb = new DatabaseSync(path.join(dataDir, 'app.db'));
rawDb.exec('PRAGMA journal_mode = WAL;');
rawDb.exec('PRAGMA foreign_keys = ON;');

rawDb.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recruiters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES recruiters(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES recruiters(id),
  title TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id),
  order_index INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id),
  candidate_name TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  consent_given_at INTEGER,
  consent_ip TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id),
  audio_path TEXT,
  value_json TEXT
);
`);

// Idempotent migration: add transcription columns to answers if an older
// data/app.db predates them. `node:sqlite` has no ALTER ... IF NOT EXISTS, so
// we check PRAGMA table_info first.
const answerCols = new Set(rawDb.prepare('PRAGMA table_info(answers)').all().map(c => c.name));
if (!answerCols.has('transcript')) {
  rawDb.exec('ALTER TABLE answers ADD COLUMN transcript TEXT');
}
if (!answerCols.has('transcript_status')) {
  rawDb.exec("ALTER TABLE answers ADD COLUMN transcript_status TEXT DEFAULT 'pending'");
}

// Projects layer: forms now hang off a project rather than directly off the org.
// Older databases predate `forms.project_id`, so add it and backfill every
// orphaned form into a per-org "General" project. The backfill is naturally
// idempotent — once assigned there are no NULL project_id rows left to move.
const formCols = new Set(rawDb.prepare('PRAGMA table_info(forms)').all().map(c => c.name));
if (!formCols.has('project_id')) {
  rawDb.exec('ALTER TABLE forms ADD COLUMN project_id TEXT REFERENCES projects(id)');
}

const orphanOrgs = rawDb
  .prepare('SELECT DISTINCT org_id, created_by FROM forms WHERE project_id IS NULL')
  .all();
if (orphanOrgs.length) {
  const crypto = require('crypto');
  const now = Date.now();
  const findGeneral = rawDb.prepare(
    "SELECT id FROM projects WHERE org_id = ? AND name = 'General' LIMIT 1"
  );
  const insertProject = rawDb.prepare(
    'INSERT INTO projects (id, org_id, created_by, name, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const assignForms = rawDb.prepare(
    'UPDATE forms SET project_id = ? WHERE org_id = ? AND project_id IS NULL'
  );
  for (const { org_id, created_by } of orphanOrgs) {
    const existing = findGeneral.get(org_id);
    const projectId = existing ? existing.id : crypto.randomUUID();
    if (!existing) insertProject.run(projectId, org_id, created_by, 'General', now);
    assignForms.run(projectId, org_id);
  }
}

// --- Question types, respondent email, and account tiers ---------------------
// All of these follow the same PRAGMA-checked pattern as the migrations above.

function columnsOf(table) {
  return new Set(rawDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

// The organization IS the account — forms.org_id already scopes every query, so
// quotas count naturally from there. DEFAULT 'full' doubles as the backfill:
// every org that predates tiers keeps working uncapped.
const orgCols = columnsOf('organizations');
if (!orgCols.has('tier')) {
  rawDb.exec("ALTER TABLE organizations ADD COLUMN tier TEXT NOT NULL DEFAULT 'full'");
}

// Questions gain a type, a required flag, and a JSON config blob holding
// everything type-specific (options, scale bounds, validation rules) so that
// adding a question type later never needs another migration.
const questionCols = columnsOf('questions');
if (!questionCols.has('type')) {
  rawDb.exec("ALTER TABLE questions ADD COLUMN type TEXT NOT NULL DEFAULT 'audio'");
}
if (!questionCols.has('required')) {
  rawDb.exec('ALTER TABLE questions ADD COLUMN required INTEGER NOT NULL DEFAULT 0');
  // Before question types every question was effectively mandatory — the
  // respondent page disabled Next until a recording existed. Preserve that.
  // Inside the add-guard so it can never re-force a question an owner later
  // made optional.
  rawDb.exec("UPDATE questions SET required = 1 WHERE type = 'audio'");
}
if (!questionCols.has('config')) {
  rawDb.exec('ALTER TABLE questions ADD COLUMN config TEXT');
}
if (!questionCols.has('deleted_at')) {
  // Soft delete: a question with answers is never removed, so historical
  // responses keep rendering with their original question text.
  rawDb.exec('ALTER TABLE questions ADD COLUMN deleted_at INTEGER');
}

const responseCols = columnsOf('responses');
if (!responseCols.has('respondent_email')) {
  // Nullable because rows that predate email capture have none; "required by
  // default" is enforced at submit time via forms.require_email instead.
  rawDb.exec('ALTER TABLE responses ADD COLUMN respondent_email TEXT');
}

const formCols2 = columnsOf('forms');
if (!formCols2.has('require_email')) {
  rawDb.exec('ALTER TABLE forms ADD COLUMN require_email INTEGER NOT NULL DEFAULT 1');
}
if (!formCols2.has('layout')) {
  // 'one_per_page' is the pre-existing wizard behaviour, so defaulting to it
  // keeps every form built before this change rendering exactly as it did.
  // New forms are created with an explicit layout from the builder.
  rawDb.exec("ALTER TABLE forms ADD COLUMN layout TEXT NOT NULL DEFAULT 'one_per_page'");
}

const answerCols2 = columnsOf('answers');
if (!answerCols2.has('value_json')) {
  rawDb.exec('ALTER TABLE answers ADD COLUMN value_json TEXT');
}

// Non-audio answers carry no file, but the original schema declared
// answers.audio_path NOT NULL. SQLite cannot drop a constraint (or add
// ON DELETE CASCADE) with ALTER TABLE, so this is the documented 12-step
// rebuild: https://sqlite.org/lang_altertable.html#otheralter
// Guarded on PRAGMA table_info's `notnull` flag, so it runs at most once.
const audioPathCol = rawDb
  .prepare('PRAGMA table_info(answers)')
  .all()
  .find(c => c.name === 'audio_path');
if (audioPathCol && audioPathCol.notnull === 1) {
  // PRAGMA foreign_keys is silently ignored inside a transaction, so it has to
  // be toggled outside BEGIN/COMMIT.
  rawDb.exec('PRAGMA foreign_keys = OFF;');
  try {
    rawDb.exec('BEGIN IMMEDIATE;');
    rawDb.exec(`
      CREATE TABLE answers_rebuild (
        id TEXT PRIMARY KEY,
        response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id),
        audio_path TEXT,
        value_json TEXT,
        transcript TEXT,
        transcript_status TEXT DEFAULT 'pending'
      );
      INSERT INTO answers_rebuild
        (id, response_id, question_id, audio_path, value_json, transcript, transcript_status)
        SELECT id, response_id, question_id, NULLIF(audio_path, ''), value_json,
               transcript, transcript_status
        FROM answers;
      DROP TABLE answers;
      ALTER TABLE answers_rebuild RENAME TO answers;
    `);
    // Step 10 of the 12-step: verify before committing, so a bad copy rolls
    // back instead of shipping.
    const dangling = rawDb.prepare('PRAGMA foreign_key_check').all();
    if (dangling.length) {
      throw new Error(`answers rebuild left dangling rows: ${JSON.stringify(dangling)}`);
    }
    rawDb.exec('COMMIT;');
  } catch (err) {
    try { rawDb.exec('ROLLBACK;'); } catch (_) { /* nothing to roll back */ }
    rawDb.exec('PRAGMA foreign_keys = ON;');
    throw err;
  }
  rawDb.exec('PRAGMA foreign_keys = ON;');
  console.log('[db] rebuilt answers table (nullable audio_path, value_json, cascade)');
}

// Indexes must come after the rebuild — anything created on `answers` earlier
// would have been dropped along with the old table.
rawDb.exec(`
CREATE INDEX IF NOT EXISTS idx_responses_form   ON responses(form_id);
CREATE INDEX IF NOT EXISTS idx_answers_response ON answers(response_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_questions_form   ON questions(form_id, order_index);
CREATE INDEX IF NOT EXISTS idx_forms_org        ON forms(org_id);
CREATE INDEX IF NOT EXISTS idx_forms_project    ON forms(project_id);
`);

// Thin wrapper so the rest of the app can keep using the better-sqlite3-style
// db.prepare(sql).get(...)/.all(...)/.run(...) calls with positional '?' params.
const db = {
  prepare(sql) {
    const stmt = rawDb.prepare(sql);
    return {
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
      run: (...params) => stmt.run(...params)
    };
  },
  exec(sql) {
    return rawDb.exec(sql);
  },
  // Multi-row writes (a form and its questions, a response and its answers) must
  // land all-or-nothing. Non-reentrant: do not nest these.
  transaction(fn) {
    rawDb.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      rawDb.exec('COMMIT;');
      return result;
    } catch (err) {
      try { rawDb.exec('ROLLBACK;'); } catch (_) { /* already unwound */ }
      throw err;
    }
  }
};

module.exports = db;
