// Seed demo data so a fresh container has something to sign into.
//
//   npm run seed
//
// Creates two accounts:
//   demo@example.com    full tier  — the working dev login, empty-ish to build in
//   viewer@example.com  demo tier  — read-only, pre-loaded with forms AND responses
//                                    so a prospect can look around without a
//                                    scratch account or any real data
//
// Idempotent: re-running won't duplicate accounts, projects, forms, or
// responses. Safe to run against an existing database.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../server/db');
const { uniqueCode } = require('../server/codes');
const { normalizeQuestion } = require('../server/questions');

// Questions carry a `key` so responses can reference them without depending on
// array positions.
const ACCOUNTS = [
  {
    email: 'demo@example.com', password: 'demo1234', name: 'Demo Creator',
    org: 'Demo Org', tier: 'full',
    projects: [
      {
        name: 'Customer Research',
        forms: [{
          title: 'Product feedback — voice survey',
          layout: 'one_per_page', requireEmail: true,
          questions: [
            { key: 'use', type: 'audio', text: 'In your own words, what did you use the product for this week?', required: true },
            { key: 'frustrating', type: 'audio', text: 'What was the single most frustrating moment, if any?', required: true },
            { key: 'change', type: 'audio', text: 'If you could change one thing, what would it be?', required: true }
          ]
        }]
      },
      {
        name: 'Q3 Engineering Hiring',
        forms: [{
          title: 'Backend Engineer — first-round screen',
          layout: 'one_per_page', requireEmail: true,
          questions: [
            { key: 'system', type: 'audio', text: 'Walk us through a system you designed and what you would change today.', required: true },
            { key: 'incident', type: 'audio', text: 'Tell us about a production incident you helped resolve.', required: true },
            { key: 'why', type: 'audio', text: 'Why are you interested in this role?', required: true }
          ]
        }]
      }
    ]
  },
  {
    email: 'viewer@example.com', password: 'viewer1234', name: 'Demo Viewer',
    org: 'SayForm Demo', tier: 'demo',
    projects: [
      {
        name: 'Customer Research',
        forms: [{
          title: 'Onboarding survey — mixed answers',
          layout: 'sectioned', requireEmail: true,
          questions: [
            { key: 's1', type: 'section', text: 'About you', config: { description: 'A few quick details before the open questions.' } },
            { key: 'role', type: 'multiple_choice', text: 'What best describes your role?', required: true,
              config: { options: ['Engineering', 'Design', 'Product', 'Operations'], allowOther: true } },
            { key: 'tools', type: 'checkboxes', text: 'Which of these do you use day to day?',
              config: { options: ['Slack', 'Notion', 'Linear', 'Figma'], allowOther: true } },
            { key: 'size', type: 'dropdown', text: 'How big is your team?',
              config: { options: ['Just me', '2–10', '11–50', '50+'] } },
            { key: 's2', type: 'section', text: 'How it went', config: { description: 'The part we actually read.' } },
            { key: 'nps', type: 'linear_scale', text: 'How likely are you to recommend us?', required: true,
              config: { min: 1, max: 10, minLabel: 'Not at all', maxLabel: 'Extremely' } },
            { key: 'started', type: 'date', text: 'When did you start using the product?' },
            { key: 'story', type: 'audio', text: 'Tell us about the moment it first clicked for you.', required: true },
            { key: 'else', type: 'paragraph', text: 'Anything else we should know?' }
          ],
          responses: [
            {
              name: 'Priya Raman', email: 'priya.raman@example.com',
              values: { role: 'Engineering', tools: ['Slack', 'Linear'], size: '11–50', nps: 9, started: '2026-03-14',
                        else: 'The transcripts are the part my team actually uses. Being able to skim ten answers in a minute changed how we run research.' },
              transcripts: { story: 'It clicked the first time I sent a link instead of scheduling six calls. I had all the answers back before the first call would even have happened, and I could skim the transcripts on my phone between meetings.' }
            },
            {
              name: 'Tom Okafor', email: 'tom.okafor@example.com',
              values: { role: 'Product', tools: ['Slack', 'Notion', 'Figma'], size: '2–10', nps: 7, started: '2026-05-02', else: '' },
              transcripts: { story: 'Honestly it was the voice answers. People say things out loud that they would never bother typing into a text box, and you can hear when someone is genuinely annoyed about something.' }
            },
            {
              name: 'Sofia Lindqvist', email: 'sofia.l@example.com',
              values: { role: 'Research ops', tools: ['Notion', 'Linear', 'Airtable'], size: '50+', nps: 10, started: '2026-01-20',
                        else: 'Would love an export straight to our warehouse, but the CSV works fine for now.' },
              transcripts: { story: 'We were running a study across four time zones and scheduling was eating the whole week. Sending one link and collecting spoken answers overnight was the moment I stopped defending the old process.' }
            }
          ]
        }]
      },
      {
        name: 'Q3 Engineering Hiring',
        forms: [{
          title: 'Backend Engineer — first-round screen',
          layout: 'one_per_page', requireEmail: true,
          questions: [
            { key: 'system', type: 'audio', text: 'Walk us through a system you designed and what you would change today.', required: true },
            { key: 'incident', type: 'audio', text: 'Tell us about a production incident you helped resolve.', required: true },
            { key: 'notice', type: 'short_text', text: 'How much notice do you need to give?' },
            { key: 'why', type: 'audio', text: 'Why are you interested in this role?', required: true }
          ],
          responses: [
            {
              name: 'Daniel Whitfield', email: 'd.whitfield@example.com',
              values: { notice: '4 weeks' },
              transcripts: {
                system: 'I built the ingestion pipeline for our events product — roughly two hundred thousand events a minute at peak. Today I would not have started with a custom queue. We spent a year rediscovering why Kafka works the way it does.',
                incident: 'We had a slow memory leak that only showed up under a specific retry path. It took three days to find because the graphs looked fine until they very suddenly did not. The fix was four lines; the postmortem was the valuable part.',
                why: 'I have spent two years on internal tooling and I miss having actual users. This role is the first backend job I have seen where the data model is the interesting part rather than an afterthought.'
              }
            },
            {
              name: 'Amara Nwosu', email: 'amara.nwosu@example.com',
              values: { notice: 'Immediately available' },
              transcripts: {
                system: 'The billing reconciliation service. It compares what we charged against what the payment provider says we charged, every night. What I would change is making it event-driven from the start instead of a nightly batch.',
                incident: 'A deploy took the search index offline for about forty minutes. I was on call. We had no read-only fallback, so search just returned errors. We shipped a stale-but-serving cache the following week.',
                why: 'I want to work somewhere the on-call rotation is treated as a design constraint rather than a rota to fill.'
              }
            }
          ]
        }]
      }
    ]
  }
];

function ensureAccount(spec) {
  const existing = db.prepare('SELECT * FROM recruiters WHERE email = ?').get(spec.email);
  if (existing) {
    // Keep the tier in step with this file even if the account predates it.
    db.prepare('UPDATE organizations SET tier = ? WHERE id = ?').run(spec.tier, existing.org_id);
    return existing;
  }

  const orgId = crypto.randomUUID();
  const recruiterId = crypto.randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, created_at, tier) VALUES (?, ?, ?, ?)')
      .run(orgId, spec.org, now, spec.tier);
    db.prepare(
      'INSERT INTO recruiters (id, org_id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(recruiterId, orgId, spec.email, bcrypt.hashSync(spec.password, 10), spec.name, now);
  });
  return db.prepare('SELECT * FROM recruiters WHERE id = ?').get(recruiterId);
}

function ensureProject(recruiter, name) {
  const existing = db.prepare('SELECT * FROM projects WHERE org_id = ? AND name = ?').get(recruiter.org_id, name);
  if (existing) return existing;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO projects (id, org_id, created_by, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, recruiter.org_id, recruiter.id, name, Date.now());
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function ensureForm(recruiter, project, spec) {
  const existing = db.prepare('SELECT * FROM forms WHERE org_id = ? AND title = ?').get(recruiter.org_id, spec.title);
  if (existing) return { form: existing, created: false };

  const formId = crypto.randomUUID();
  const code = uniqueCode();
  const now = Date.now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO forms (id, org_id, project_id, created_by, title, code, status, created_at, require_email, layout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(formId, recruiter.org_id, project.id, recruiter.id, spec.title, code, 'published', now,
          spec.requireEmail === false ? 0 : 1, spec.layout || 'sectioned');

    const insertQ = db.prepare(
      'INSERT INTO questions (id, form_id, order_index, text, type, required, config) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // Run every seeded question through the same normalizer the API uses, so
    // the seed can't produce shapes the app would have rejected.
    spec.questions.forEach((q, i) => {
      const row = normalizeQuestion(q);
      insertQ.run(crypto.randomUUID(), formId, i, row.text, row.type, row.required, row.config);
    });
  });

  return { form: db.prepare('SELECT * FROM forms WHERE id = ?').get(formId), created: true };
}

function seedResponses(form, spec) {
  if (!spec.responses || !spec.responses.length) return 0;
  const already = db.prepare('SELECT COUNT(*) c FROM responses WHERE form_id = ?').get(form.id).c;
  if (already) return 0; // don't stack duplicates on re-run

  // Map the spec's stable keys onto the question rows that were just inserted.
  const rows = db.prepare('SELECT id, type, order_index FROM questions WHERE form_id = ? ORDER BY order_index').all(form.id);
  const byKey = new Map();
  spec.questions.forEach((q, i) => byKey.set(q.key, rows[i]));

  const hasAudio = spec.questions.some(q => q.type === 'audio');
  let seeded = 0;

  db.transaction(() => {
    spec.responses.forEach((r, n) => {
      const responseId = crypto.randomUUID();
      // Stagger the timestamps so the list looks like it accumulated over days.
      const submittedAt = Date.now() - (n + 1) * 36 * 60 * 60 * 1000;
      db.prepare(
        `INSERT INTO responses (id, form_id, candidate_name, respondent_email, submitted_at, consent_given_at, consent_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(responseId, form.id, r.name, r.email, submittedAt,
            hasAudio ? submittedAt : null, hasAudio ? '203.0.113.42' : null);

      const insertAnswer = db.prepare(
        `INSERT INTO answers (id, response_id, question_id, audio_path, value_json, transcript, transcript_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      // One row per input question, blanks included — the same grain the real
      // submit path writes.
      for (const q of spec.questions) {
        if (q.type === 'section') continue;
        const row = byKey.get(q.key);
        if (q.type === 'audio') {
          const transcript = (r.transcripts || {})[q.key] || null;
          // No audio file is fabricated: the transcript stands in for the
          // recording, which is exactly how a response whose file was pruned
          // by a retention policy looks.
          insertAnswer.run(crypto.randomUUID(), responseId, row.id, null, null,
                           transcript, transcript ? 'done' : null);
        } else {
          const v = (r.values || {})[q.key];
          const blank = v === undefined || v === '' || (Array.isArray(v) && !v.length);
          insertAnswer.run(crypto.randomUUID(), responseId, row.id, null,
                           blank ? null : JSON.stringify(v), null, null);
        }
      }
      seeded++;
    });
  });
  return seeded;
}

console.log('\nSeeded demo data:\n');
for (const spec of ACCOUNTS) {
  const recruiter = ensureAccount(spec);
  console.log(`  ${spec.email} / ${spec.password}   [${spec.tier} tier]  ${spec.org}`);
  for (const projectSpec of spec.projects) {
    const project = ensureProject(recruiter, projectSpec.name);
    for (const formSpec of projectSpec.forms) {
      const { form } = ensureForm(recruiter, project, formSpec);
      const added = seedResponses(form, formSpec);
      const count = db.prepare('SELECT COUNT(*) c FROM responses WHERE form_id = ?').get(form.id).c;
      console.log(`     ${projectSpec.name} › ${form.title}`);
      console.log(`       /apply.html?code=${form.code}   ${count} response${count === 1 ? '' : 's'}${added ? ' (seeded)' : ''}`);
    }
  }
  console.log('');
}
console.log('  The demo-tier account is read-only: it can browse everything and change nothing.');
console.log('  Start the server and sign in at /index.html\n');
