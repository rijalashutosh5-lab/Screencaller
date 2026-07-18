# Signal Screen — Voice Screening Platform

A real, working platform: recruiters build screening forms, candidates answer by
voice recording, recruiters review responses. Runs locally today; the storage
layer is designed to swap to S3/Postgres later without touching the app logic.

## What's actually working
- Recruiter accounts (register/login) scoped to an organization
- Form builder — publish a form, get a 6-character share code
- Candidate flow — enter code, consent screen, record one answer per question
  with a live waveform, re-record before submitting
- Recruiter dashboard — review submissions per form, play back each answer
- Consent is recorded server-side with a timestamp and IP, not just a UI checkbox

## Stack
- Node.js + Express
- SQLite (via `better-sqlite3`) — a single file database, zero setup, good enough
  for real usage at small-to-mid volume
- Audio files stored on local disk under `/uploads`
- JWT auth for recruiters; candidates need no account, just the form code

## Run it

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET to a real random string
npm start
```

Open `http://localhost:3000`:
- `/index.html` — recruiter sign in / create account
- `/dashboard.html` — build forms, review responses (requires sign in)
- `/apply.html` — candidate flow (also works as `/apply.html?code=ABC123` for a direct link)

That's it — no external services required to run this today.

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
