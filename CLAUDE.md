# CLAUDE.md

Architectural decision log for **Signal Screen** — a voice-based candidate
screening platform (Google Forms for recruiters, but candidates answer by
voice recording instead of typing).

## Core concept
- Recruiters build a form of text questions.
- Candidates open a shared link, consent to being recorded, and record one
  voice answer per question in the browser.
- Recruiters review submissions and play back each answer instead of running
  a live first-round screening call.

## Stack decisions

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + Express | Simple, well-understood, no framework overhead needed for this surface area. |
| Database | SQLite via Node's built-in `node:sqlite` (not `better-sqlite3`) | `better-sqlite3` is a native module requiring Python + build tools to compile on install; this broke on a Windows machine with no build toolchain. `node:sqlite` ships with Node itself (22.5+), needs zero native compilation, and exposes a near-identical synchronous `prepare().get/all/run()` API, so the swap didn't touch any route code. |
| Audio storage | Local disk (`/uploads`), path stored in DB | Zero setup for local/early use. Explicitly *not* production-final — see "Known limitations" below. |
| Auth (recruiters) | JWT, signed server-side, stored in `localStorage` on the client | Recruiters need persistent sessions across page loads; no server-side session store needed at this scale. |
| Auth (candidates) | None — a form is accessed via an unguessable 6-character share code, no login | Candidates shouldn't need to create an account to answer a screening form. Code stands in for a link/token. |
| Frontend | Vanilla JS + hand-rolled CSS, no framework/build step | Small enough surface area that React/bundling would add more overhead than value; keeps `npm install` and `npm start` as the entire setup. |

## Data model
```
organizations (tier) → recruiters
organizations → projects → forms → questions (type, config, deleted_at)
forms → responses (respondent_email) → answers (audio_path | value_json)
```
- `forms.org_id` scopes every form to an org; all list/read queries filter by
  the authenticated recruiter's `org_id` so orgs can't see each other's data.
- `forms.code` is the public, unguessable share identifier (not the DB `id`).
- Consent is captured as first-class columns on `responses`
  (`consent_given_at`, `consent_ip`), written server-side at submission time —
  not inferred from a client-side checkbox alone — so it's auditable later.
  It's only recorded for forms that actually contain a voice question.
- **The organization *is* the account.** Tier lives on `organizations.tier`
  rather than a new `accounts` table, because `forms.org_id` already scopes
  everything, and because the response cap has to be resolved on the public
  invite route where there is no logged-in recruiter — only a form code. From
  there `forms JOIN organizations` reaches the tier in one hop; going via
  `forms.created_by` would break as soon as an org has two recruiters.

## API shape
- `POST /api/auth/login` — returns JWT. `POST /api/auth/register` still exists but
  is no longer linked from the UI (see "Accounts and tiers").
- `GET /api/me` — the signed-in account: tier, limits, and usage.
- `POST|GET /api/forms`, `GET|PUT|DELETE /api/forms/:id` — JWT-protected, org-scoped.
- `GET /api/forms/:id/responses`, `DELETE /api/forms/:id/responses/:responseId` —
  the delete is nested under the form so org scoping comes free from the form
  lookup, instead of needing its own join.
- `GET /api/invite/:code` — public, respondent loads a form by code.
- `POST /api/invite/:code/submit` — public, multipart; audio as `answer_<questionId>`
  file fields, everything else as JSON-encoded `value_<questionId>` text fields.
- `GET /api/audio/:answerId` — JWT-protected, org-ownership checked via a join through
  `responses → forms`, so a recruiter can only stream audio from their own org.

**Auth is applied at the mount points in `server/index.js`, not inside each
router.** `requireAuth` loads the account (and its tier) from the DB on every
request rather than trusting the token, so a tier change or a deleted account
takes effect immediately instead of after the 30-day token expiry.
`blockDemoWrites` then rejects any non-GET for a read-only tier. Gating on the
HTTP **method** rather than a route list means an endpoint added later is
covered without anyone remembering to guard it.

Answers upload in a single multipart request at final submission (the
respondent records everything client-side first, then uploads together) —
simpler than a per-answer endpoint, and avoids partial/orphaned uploads if
someone abandons the flow midway.

## Consent flow
Added as a required step between "enter name" and "record answers":
- Plain-language explanation of what's recorded and shared.
- Checkbox gates the "Agree and start" button — recording can't start without it.
- Timestamp + submitter IP recorded server-side on submit, not trusted from
  client state, so it holds up as an actual record rather than just a UI gesture.

## UX decision: link sharing
Initially the dashboard only surfaced the bare 6-character `code`, with no
actual link — this made the candidate-facing side effectively undiscoverable.
Fixed by:
- Auto-copying the full `/apply.html?code=XXXX` link to the clipboard immediately after publishing, plus showing it in a banner.
- A persistent "Copy link" + "Preview" action on every form row and on the responses view, so the link is always retrievable, not just shown once at creation time.

## Positioning: dual-purpose voice forms (not hiring-only)
The engine (form → questions → responses → audio answers) was always generic;
only the surface copy was hiring-coded. Repositioned as a general **voice-forms**
tool that serves hiring screens *and* surveys/research, since Google Forms has no
native voice input. Implementation kept minimal: **user-facing copy** was
neutralized (creator/respondent/"voice form") across the three `public/` pages,
but **internal identifiers were deliberately left alone** (DB column
`candidate_name`, localStorage key `recruiter`, JS var names) to avoid a churny
rename with no user-visible payoff.

## Transcription (mock-first, swappable)
`server/transcribe.js` exposes `transcribe(audioPath)` behind a `TRANSCRIBER`
env switch. It ships a **mock** provider (placeholder text, small artificial
delay so the "Transcribing… → done" UI is visible) so the full pipeline runs
with zero external dependencies. On submit, `routes/invite.js` fires a
`setImmediate` fire-and-forget job — per answer: status `processing` →
`transcribe()` → write `transcript` + status `done` (or `failed`). Results are
stored on two new `answers` columns (`transcript`, `transcript_status`) added via
an idempotent PRAGMA-checked migration in `db.js`, surfaced by
`GET /forms/:id/responses`, and rendered beside each audio player in the
dashboard. Going live = implement the `openai`/`claude` branch and set the env —
no other file changes.

## Cross-browser & mobile recording
The candidate recorder previously hardcoded `audio/webm`, which iOS Safari does
not produce (it emits `audio/mp4`) — recordings would have failed on iPhones.
`apply.html` now picks a supported type via `MediaRecorder.isTypeSupported`
(webm → mp4 → ogg) and the multer `filename` in `routes/invite.js` derives the
file extension from the real MIME type, so `res.sendFile` serves the correct
`Content-Type` on playback. A `<meta viewport>` and a small `@media` block were
added for phone-sized layouts (respondents are mostly on mobile).

## Packaging: Docker
Containerized with a `node:22-alpine` image (`Dockerfile` + `docker-compose.yml`).
This is also the cleanest fix for the `node:sqlite` requirement (Node ≥ 22.5) —
the base image satisfies it regardless of the host's Node version. `data/` and
`uploads/` are mounted as volumes so the DB and recordings persist across
container restarts. `scripts/seed.js` (`npm run seed`) creates a demo login +
sample forms for an instant demo.

## Question types
Questions gained `type`, `required`, `config` (JSON), and `deleted_at`. **All
type-specific shape lives in the one `config` blob** — options, scale bounds and
labels, validation rules — so adding a type is a change to `server/questions.js`
plus a renderer, never another migration. The alternative, a `question_options`
child table, was rejected: it adds a join to four read sites that currently do
none, and it tempts an `answers.option_id` foreign key, after which deleting an
option would orphan history. Answers store option **labels**, so renaming or
removing an option can never corrupt an already-submitted answer.

`questions.text` was deliberately **not** renamed to `label`. It's read in four
server files plus both pages; the rename buys nothing user-visible — the same
call already made for `candidate_name` and the `recruiter` localStorage key.

A `section` is a question row of type `section`: it lives in the same
`order_index` space so sections reorder with questions, and it is both a heading
and a page break. `forms.layout` then decides what a page is — `one_per_page`
(the pre-existing wizard, and the column default so **every form built before
this change renders exactly as it did**) or `sectioned`.

## Answer storage
`answers.audio_path` was `NOT NULL`, which stopped being true the moment an
answer could be text. SQLite can't drop a constraint, so `db.js` does the
documented 12-step table rebuild, guarded on `PRAGMA table_info`'s `notnull`
flag so it runs at most once. Two things that are easy to get wrong and are
commented in place: `PRAGMA foreign_keys` is silently ignored **inside** a
transaction, so it's toggled outside; and `foreign_key_check` runs before
`COMMIT` so a bad copy rolls back rather than shipping.

Non-audio answers store `value_json` — always JSON-encoded, so multi-select
arrays and numeric scales keep their type on the round trip. `server/answerValue.js`
is the only place it's decoded or flattened.

**One answer row is written per input question, including skipped ones**
(`value_json` NULL). Both the dashboard and the CSV export numbered questions by
array position, which silently misaligns as soon as a respondent can skip one;
keeping the grain fixed makes the numbering correct by construction and makes
"skipped" explicit in exports.

## Accounts and tiers
`demo` (view-only) / `free` (5 forms, 20 responses **per form**) / `full`
(uncapped), in `server/tiers.js`. An unknown or NULL tier fails **open** to
`full` so a bad column value can never lock a paying account out of its own data.

Limits are enforced server-side, never only in the UI: the form cap in a
`POST /api/forms` middleware, the response cap on the public invite route. The
response cap has a subtlety — `resolveIntake` counts before multer spends many
event-loop turns receiving the upload, so two respondents at the boundary can
both pass it. The handler therefore re-counts immediately before the INSERT,
and that block is **synchronous on purpose**: `DatabaseSync` is synchronous and
Node is single-threaded, so a COUNT and an INSERT with no `await` between them
are atomic against other requests. Adding an `await` there silently reopens the
race; there's a comment saying so.

Closing intake never hides or deletes anything — the owner keeps every response
they already have. Demo-tier forms are closed to new submissions too, so the
seeded sample data stays pristine.

There is **no self-serve sign-up in the UI**; accounts are provisioned with
`scripts/account.js` and credentials shared directly. `POST /api/auth/register`
still exists and is unauthenticated — a deliberate call, not an oversight — so
it assigns the capped `free` tier rather than `full`. Deleting the route is a
one-line change if that hole matters later. **Known gap: no password reset** —
`npm run account -- set-password` is the admin path.

## Editing a form that already has responses
A question with answers is never hard-deleted. Dropping it from the form sets
`deleted_at`, so it disappears from the builder and the respondent view while
still joining for the dashboard and export — history never orphans. Only three
read sites filter `deleted_at`; the answer-joining queries deliberately do not.
Changing the **type** of an answered question returns 409, because the stored
`value_json` encoding wouldn't match — an audio answer under a question now
claiming to be a scale is unrenderable.

## Earlier known limitations (still deliberate non-goals for now)
- **Local disk storage doesn't survive PaaS redeploys without a volume.** Under
  Docker this is handled by the mounted `data/`/`uploads/` volumes; the S3 path
  (presigned upload/GET, scoped to `routes/invite.js` + `routes/audio.js`)
  remains the production answer.
- **SQLite is single-writer.** Fine through meaningful usage; if horizontally
  scaling the API to multiple instances behind a load balancer, migrate to
  Postgres — the schema is already normalized and maps over close to 1:1.
- **Minimal hardening this pass.** Rate limiting, CORS lockdown, and a real
  enforced `JWT_SECRET` are still open; fine for a demo, revisit before real use.
- **No team accounts.** One login per account; `recruiters` can hold more than
  one row per org, but nothing in the UI creates a second.
- **`projects.js` has no DELETE** — archive is the only removal.
- **No transcription in the original POC.** Now addressed as an async job on
  answer upload (mock provider; Whisper API / AWS Transcribe / Claude when going
  live) — see the Transcription section above.
