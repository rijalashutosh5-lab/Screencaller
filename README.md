# Signal — Voice Forms Platform

A "Google Forms, but answers are spoken, not typed" platform. Build a form of
text questions, share a link, and get back a voice recording per question —
useful for **hiring screens, customer/product surveys, user research, and any
survey where hearing the answer beats reading it**. Google Forms has no native
voice input; this fills that gap.

Runs locally or in Docker; the storage layer is designed to swap to S3/Postgres
later without touching the app logic.

## What's actually working
- **Ten question types** — voice, short answer, paragraph, multiple choice,
  checkboxes, dropdown, linear scale, date, time, and section/page break — with
  a per-question Required toggle, an optional "Other" free-text choice, and
  email / number-range / regex validation
- Form builder — reorder questions, edit a published form, publish and get a
  6-character share code + link
- Respondent flow — multi-page forms, one recorder per voice question with a
  live waveform, re-record before submitting (desktop + mobile, Chrome/Firefox/
  Safari incl. iOS)
- **Respondent email** captured as a first-class field, required by default and
  toggleable per form, validated on both sides and shown against every response
- Dashboard — review submissions per form, play back voice answers, read the
  auto-generated transcript, delete a response or a whole form
- **Account tiers** — demo (view-only) / free (5 forms, 20 responses each) /
  full — enforced server-side, not just hidden in the UI
- Consent is recorded server-side with a timestamp and IP, not just a UI checkbox,
  and is only asked for on forms that actually record audio
- CSV + JSON + audio export, per form or per project
- Transcription pipeline (mock by default, swappable for a real API — see below)

## Stack
- Node.js (>= 22.5) + Express
- SQLite via Node's **built-in** `node:sqlite` module — no native compilation,
  no Python/build tools required, works the same on Windows/Mac/Linux
- Audio files stored on local disk under `/uploads`
- JWT auth for creators; respondents need no account, just the form code
- No frontend framework and no build step — three static pages of vanilla JS

## Run it with Docker (recommended)

The `node:22` base image ships `node:sqlite`, so you don't need a specific Node
version on the host — this is the easiest way to run and expose a demo.

```bash
# optional: set a real secret (defaults to a placeholder otherwise)
export JWT_SECRET="$(openssl rand -hex 32)"

docker compose up --build
docker compose exec app npm run seed   # demo logins + sample forms and responses
```

`data/` (SQLite) and `uploads/` (audio) are mounted as volumes, so forms and
recordings survive `docker compose restart`.

## Or run it directly with Node

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET to a real random string
npm run seed              # optional: demo login + sample forms
npm start
```

You need **Node 22.5 or newer** (check with `node -v`) — that's what ships
`node:sqlite`. You'll see a one-line `ExperimentalWarning: SQLite is an
experimental feature` on startup; that's expected and harmless, not an error.

## Using it

Open `http://localhost:3000`:
- `/index.html` — creator sign in / create account
- `/dashboard.html` — build forms, review responses + transcripts (requires sign in)
- `/apply.html` — respondent flow (also works as `/apply.html?code=ABC123` for a direct link)

`npm run seed` creates two logins:

| Login | Tier | What it's for |
|---|---|---|
| `demo@example.com` / `demo1234` | full | A normal working account to build in |
| `viewer@example.com` / `viewer1234` | demo | Read-only, pre-loaded with sample forms **and responses** — hand this to someone who wants a look around |

## Accounts

There is no self-serve sign-up. Accounts are created by an admin and the
credentials shared with the customer directly:

```bash
docker compose exec app npm run account -- list
docker compose exec app npm run account -- create --email a@b.co --password s3cret --org "Acme" --tier free
docker compose exec app npm run account -- set-tier --email a@b.co --tier full
docker compose exec app npm run account -- set-password --email a@b.co --password newpw
```

Tiers, all enforced server-side (hitting the API directly won't get you past them):

| Tier | Forms | Responses per form | Writes |
|---|---|---|---|
| `demo` | — | — | rejected at the API; share links stop collecting |
| `free` | 5 | 20, then intake closes | allowed |
| `full` | unlimited | unlimited | allowed |

Closing intake never hides or deletes anything already collected.

**Known gap:** there's no self-service password reset — use
`npm run account -- set-password`.

**Exposing a demo publicly:** put it behind an HTTPS tunnel/proxy (e.g.
Cloudflare Tunnel, ngrok). Microphone access and clipboard "Copy link" only work
on `localhost` or over HTTPS — browsers block them on plain HTTP off-localhost.

## Transcription

Every uploaded answer is run through a transcriber (`server/transcribe.js`) and
the result shows up beside the audio in the dashboard. It ships in **mock mode**
by default (placeholder text, no external dependency), so the whole
pipeline — async job → DB → UI — works out of the box.

To use a real transcriber, implement the `openai` branch in
`server/transcribe.js` (a Whisper/Claude call) and set `TRANSCRIBER=openai`. No
other file changes.

## Tests

```bash
npm test        # runs on plain Node — no database, no container needed
```

Covers the pure modules (question config validation, submission validation,
tiers, answer encoding) plus the two pages' own logic — paging, client-side
validation, and the submit payload — by loading their inline scripts into a VM
with a stubbed DOM. Layout, a real microphone, and focus behaviour still need a
browser and a human.

## Project layout

```
server/
  index.js          Express app entrypoint; auth is mounted here, not per-router
  db.js             SQLite schema, migrations, transaction helper
  auth.js           JWT + per-request account/tier load, demo write block
  tiers.js          Tier definitions and limits
  questions.js      Question type registry, config validation
  answerValue.js    The one place answer values are encoded/decoded/flattened
  validation.js     Submission validation (pure; unit-tested)
  codes.js          Share-code generation
  routes/
    auth.js         login (+ a register route no longer linked from the UI)
    me.js           tier, limits, usage
    projects.js     create/list/rename/archive projects
    forms.js        build, edit, delete forms; read and delete responses
    invite.js       public: load a form by code, submit answers
    audio.js        org-scoped audio streaming
    export.js       CSV + JSON + audio zip
public/
  index.html          sign in
  dashboard.html      builder + responses
  apply.html          respondent flow
  style.css
scripts/
  seed.js           demo accounts, forms, and sample responses
  account.js        admin: create accounts, set tiers, reset passwords
test/
uploads/              recorded audio files (gitignore this in production)
data/                 app.db (SQLite file, gitignore this too)
```

## Deploying somewhere real
This runs as a single Node process with a local SQLite file and local disk
storage, which is genuinely fine for early usage but has two limits worth
knowing before you scale:

1. **Disk-backed storage doesn't survive most PaaS deploys** (Render, Railway,
   etc. wipe the filesystem on redeploy unless you attach a persistent volume).
   For anything beyond a pilot, swap `uploads/` for S3 — see
   `backend-architecture.md` for the presigned-upload pattern. It's a change
   contained entirely to `routes/invite.js` and `routes/audio.js`.
2. **SQLite is single-file, single-writer.** Fine up through a meaningful
   amount of usage, but if you're running multiple app servers behind a load
   balancer, move to Postgres — the schema in `db.js` maps over almost
   line-for-line since it's already normalized.

## Security notes before real respondents use this
- Set a real `JWT_SECRET` in `.env` — never use the default in production.
- Serve over HTTPS — the app sends passwords and JWTs in plaintext over HTTP.
- Consider a data retention policy for recordings (see `backend-architecture.md`).
- Uploads are capped at 25MB per recording, 50 files and 300 fields per
  submission — adjust in `routes/invite.js` if needed.
- `POST /api/auth/register` is still reachable even though the UI no longer
  links it. It assigns the capped `free` tier, but delete the route in
  `routes/auth.js` if you want sign-up fully closed.
