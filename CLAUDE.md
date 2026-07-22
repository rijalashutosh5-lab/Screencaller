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
organizations → recruiters → forms → questions
forms → responses → answers (audio_path, question_id)
```
- `forms.org_id` scopes every form to a recruiting org; all list/read queries
  filter by the authenticated recruiter's `org_id` so orgs can't see each
  other's data.
- `forms.code` is the public, unguessable share identifier (not the DB `id`).
- Consent is captured as first-class columns on `responses`
  (`consent_given_at`, `consent_ip`), written server-side at submission time —
  not inferred from a client-side checkbox alone — so it's auditable later.

## API shape
- `POST /api/auth/register`, `POST /api/auth/login` — recruiter auth, returns JWT.
- `POST /api/forms`, `GET /api/forms`, `GET /api/forms/:id` — recruiter-only, JWT-protected, org-scoped.
- `GET /api/forms/:id/responses` — recruiter-only, returns responses + signed-by-auth audio URLs.
- `GET /api/invite/:code` — public, candidate loads a form by code.
- `POST /api/invite/:code/submit` — public, multipart upload; one audio file per question, fields named `answer_<questionId>`.
- `GET /api/audio/:answerId` — JWT-protected, org-ownership checked via a join through `responses → forms`, so a recruiter can only stream audio belonging to their own org.

Audio upload happens in a single multipart request at final submission
(candidate records all answers client-side first, then uploads together) —
simpler than a per-answer upload endpoint, and avoids partial/orphaned
uploads if a candidate abandons the flow midway.

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
- **No transcription in the original POC.** Now addressed as an async job on
  answer upload (mock provider; Whisper API / AWS Transcribe / Claude when going
  live) — see the Transcription section above.
