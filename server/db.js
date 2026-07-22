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
  response_id TEXT NOT NULL REFERENCES responses(id),
  question_id TEXT NOT NULL REFERENCES questions(id),
  audio_path TEXT NOT NULL
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
  }
};

module.exports = db;
