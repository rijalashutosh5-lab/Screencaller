// Swappable transcription layer.
//
// Voice answers are only skimmable/searchable once they're text, so every
// uploaded answer gets run through transcribe(). Today this ships a *mock*
// transcriber so the whole pipeline (async job → DB column → dashboard UI)
// works end-to-end with zero external dependencies. To go live, implement the
// `openai` (or `claude`) branch below and set TRANSCRIBER in the environment —
// no other file needs to change.

const fs = require('fs');
const path = require('path');

const PROVIDER = process.env.TRANSCRIBER || 'mock';

// Small deterministic delay so the dashboard's "Transcribing…" → done state is
// actually visible during a demo rather than resolving instantly.
const MOCK_DELAY_MS = Number(process.env.TRANSCRIBER_MOCK_DELAY_MS || 1500);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transcribeMock(audioPath) {
  await delay(MOCK_DELAY_MS);
  let sizeKb = 0;
  try {
    sizeKb = Math.round(fs.statSync(audioPath).size / 1024);
  } catch (_) {
    /* file may be gone; size is cosmetic for the mock */
  }
  const name = path.basename(audioPath);
  return (
    `[mock transcript] Automatic transcription is running in mock mode, so this ` +
    `is placeholder text standing in for the spoken answer (${sizeKb}KB, ${name}). ` +
    `Set TRANSCRIBER=openai and add a real provider in server/transcribe.js to get ` +
    `actual transcripts.`
  );
}

// Example real implementation — left unwired on purpose (no API key needed for
// the demo). Fill this in and set TRANSCRIBER=openai to go live.
async function transcribeOpenAI(audioPath) {
  throw new Error(
    'TRANSCRIBER=openai is not implemented yet — plug a real Whisper/Claude ' +
    'call into transcribeOpenAI() in server/transcribe.js'
  );
}

async function transcribe(audioPath) {
  switch (PROVIDER) {
    case 'openai':
      return transcribeOpenAI(audioPath);
    case 'mock':
    default:
      return transcribeMock(audioPath);
  }
}

module.exports = { transcribe, PROVIDER };
