# Signal — Voice Forms Platform

A "Google Forms, but answers are spoken, not typed" platform. Build a form of
text questions, share a link, and get back a voice recording per question —
useful for **hiring screens, customer/product surveys, user research, and any
survey where hearing the answer beats reading it**. Google Forms has no native
voice input; this fills that gap.

Runs locally or in Docker; the storage layer is designed to swap to S3/Postgres
later without touching the app logic.

## What's actually working
- Creator accounts (register/login) scoped to an organization
- Form builder — publish a form, get a 6-character share code + link
- Respondent flow — enter code, consent screen, record one answer per question
  with a live waveform, re-record before submitting (works on desktop + mobile,
  Chrome/Firefox/Safari incl. iOS)
- Dashboard — review submissions per form, play back each answer, and read an
  auto-generated transcript beside it
- Consent is recorded server-side with a timestamp and IP, not just a UI checkbox
- Transcription pipeline (mock by default, swappable for a real API — see below)

## Stack
- Node.js (>= 22.5) + Express
- SQLite via Node's **built-in** `node:sqlite` module — no native compilation,
  no Python/build tools required, works the same on Windows/Mac/Linux
- Audio files stored on local disk under `/uploads`
- JWT auth for recruiters; candidates need no account, just the form code

## Run it with Docker (recommended)

The `node:22` base image ships `node:sqlite`, so you don't need a specific Node
version on the host — this is the easiest way to run and expose a demo.

```bash
# optional: set a real secret (defaults to a placeholder otherwise)
export JWT_SECRET="$(openssl rand -hex 32)"

docker compose up --build
docker compose exec app npm run seed   # optional: demo login + sample forms
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

The `npm run seed` script prints a demo login (`demo@example.com` / `demo1234`)
and two sample forms so you can start immediately.

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

## Project layout

```
server/
  index.js          Express app entrypoint
  db.js             SQLite schema + connection
  auth.js           JWT signing/verification middleware
  routes/
    auth.js         register/login
    forms.js        recruiter: create/list forms, view responses
    invite.js        candidate: load form by code, submit answers
    audio.js         recruiter-only, org-scoped audio streaming
public/
  index.html         recruiter sign in / register
  dashboard.html      recruiter: builder + responses
  apply.html          candidate flow
  style.css
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

## Security notes before real candidates use this
- Set a real `JWT_SECRET` in `.env` — never use the default in production.
- Serve over HTTPS — the app sends passwords and JWTs in plaintext over HTTP.
- Consider a data retention policy for recordings (see `backend-architecture.md`).
- The candidate audio upload is capped at 25MB per answer — adjust in
  `routes/invite.js` if needed.
