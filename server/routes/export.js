const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db');
const { displayValue, decodeValue, isSkipped } = require('../answerValue');

// Auth is applied at the mount point in server/index.js.
const router = express.Router();

// Make a string safe to use as a file/folder name inside the zip.
function safeName(s, fallback) {
  const cleaned = (s || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60);
  return cleaned || fallback;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Gather every response + answer for a set of forms into a flat structure the
// CSV, JSON, and audio-file writers all read from.
function collectExport(forms) {
  const getResponses = db.prepare('SELECT * FROM responses WHERE form_id = ? ORDER BY submitted_at DESC');
  // Deliberately not filtered by q.deleted_at: an answer to a question that has
  // since been removed from the form still belongs in the owner's export.
  const getAnswers = db.prepare(`
    SELECT a.id, a.audio_path, a.value_json, a.transcript, a.transcript_status,
           q.text AS question_text, q.type AS question_type, q.order_index
    FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.response_id = ? ORDER BY q.order_index
  `);

  const rows = [];   // CSV rows (no raw disk path)
  const files = [];  // { audioFile, audioPath } to add to the archive
  const forJson = [];
  for (const form of forms) {
    const responses = getResponses.all(form.id);
    const jsonResponses = [];
    for (const r of responses) {
      const answers = getAnswers.all(r.id);
      const respFolder = `${safeName(form.title, form.code)}/${safeName(r.candidate_name, 'respondent')}-${r.id.slice(0, 8)}`;
      const jsonAnswers = [];
      // Numbering follows the form's own question order. Every input question
      // gets a row even when it was skipped, so Q05 stays Q05 across responses.
      answers.forEach((a, i) => {
        const question = { type: a.question_type };
        const order = i + 1;
        // Only audio answers have a file; everything else leaves the column blank.
        const audioFile = a.audio_path
          ? `${respFolder}/Q${String(order).padStart(2, '0')}${path.extname(a.audio_path) || '.webm'}`
          : '';
        const value = displayValue(question, a);

        rows.push([
          form.title, form.code, r.candidate_name, r.respondent_email || '',
          new Date(r.submitted_at).toISOString(),
          r.consent_given_at ? new Date(r.consent_given_at).toISOString() : '',
          r.consent_ip || '',
          order, a.question_type || 'audio', a.question_text,
          value, a.transcript || '', a.transcript_status || '',
          audioFile
        ]);
        if (a.audio_path) files.push({ audioFile, audioPath: a.audio_path });
        jsonAnswers.push({
          questionOrder: order,
          questionType: a.question_type || 'audio',
          questionText: a.question_text,
          // The raw JS value (array, number, string) rather than the flattened
          // string, so the JSON export stays machine-readable.
          value: decodeValue(a),
          skipped: isSkipped(question, a),
          transcript: a.transcript || null,
          transcriptStatus: a.transcript_status || null,
          audioFile: audioFile || null
        });
      });
      jsonResponses.push({
        respondent: r.candidate_name,
        respondentEmail: r.respondent_email || null,
        submittedAt: new Date(r.submitted_at).toISOString(),
        consentGivenAt: r.consent_given_at ? new Date(r.consent_given_at).toISOString() : null,
        consentIp: r.consent_ip || null,
        answers: jsonAnswers
      });
    }
    forJson.push({ formTitle: form.title, formCode: form.code, responses: jsonResponses });
  }
  return { rows, files, forJson };
}

// Stream a zip (responses.csv + responses.json + audio files) for a set of forms.
function streamZip(res, forms, downloadName) {
  const { rows, files, forJson } = collectExport(forms);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { res.status(500).end(); console.error('Export zip error:', err.message); });
  archive.pipe(res);

  // Note for anything consuming these files: respondent_email, question_type,
  // and answer_value are new columns as of question types.
  const header = [
    'form_title', 'form_code', 'respondent', 'respondent_email', 'submitted_at',
    'consent_given_at', 'consent_ip', 'question_order', 'question_type', 'question_text',
    'answer_value', 'transcript', 'transcript_status', 'audio_file'
  ];
  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  archive.append(csv, { name: 'responses.csv' });
  archive.append(JSON.stringify({ forms: forJson }, null, 2), { name: 'responses.json' });

  // Add each audio file under its per-response folder path.
  for (const { audioFile, audioPath } of files) {
    if (fs.existsSync(audioPath)) archive.file(audioPath, { name: audioFile });
  }

  archive.finalize();
}

// Export one form
router.get('/forms/:id', (req, res) => {
  const form = db
    .prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.recruiter.orgId);
  if (!form) return res.status(404).json({ error: 'Form not found' });
  streamZip(res, [form], `${safeName(form.title, form.code)}.zip`);
});

// Export every form in a project
router.get('/projects/:id', (req, res) => {
  const project = db
    .prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.recruiter.orgId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const forms = db
    .prepare('SELECT * FROM forms WHERE project_id = ? AND org_id = ?')
    .all(project.id, req.recruiter.orgId);
  streamZip(res, forms, `${safeName(project.name, 'project')}.zip`);
});

module.exports = router;
