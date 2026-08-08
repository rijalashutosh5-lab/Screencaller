const express = require('express');
const crypto = require('crypto');
const db = require('../db');

// Auth + tier enforcement are applied at the mount point in server/index.js.
const router = express.Router();

// Create a project
router.post('/', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO projects (id, org_id, created_by, name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.recruiter.orgId, req.recruiter.id, name, now);

  res.json({ id, name });
});

// List this org's projects, each with a form count. Archived last.
router.get('/', (req, res) => {
  const projects = db
    .prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY archived_at IS NOT NULL, created_at DESC')
    .all(req.recruiter.orgId);
  const withCounts = projects.map(p => ({
    ...p,
    formCount: db.prepare('SELECT COUNT(*) c FROM forms WHERE project_id = ?').get(p.id).c
  }));
  res.json(withCounts);
});

// Fetch one project (must belong to caller's org)
router.get('/:id', (req, res) => {
  const project = db
    .prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.recruiter.orgId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// Rename or archive/unarchive a project
router.patch('/:id', (req, res) => {
  const project = db
    .prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.recruiter.orgId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const body = req.body || {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, project.id);
  }
  if (typeof body.archived === 'boolean') {
    db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run(body.archived ? Date.now() : null, project.id);
  }

  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
});

module.exports = router;
