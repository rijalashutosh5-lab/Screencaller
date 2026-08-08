const jwt = require('jsonwebtoken');
const db = require('./db');
const { tierConfig } = require('./tiers');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(recruiter) {
  return jwt.sign(
    { id: recruiter.id, orgId: recruiter.org_id, email: recruiter.email },
    SECRET,
    { expiresIn: '30d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // The tier is deliberately NOT carried in the token. Tokens live 30 days, so
  // an admin changing a tier — or removing an account outright — has to take
  // effect on the very next request, not a month later. This is one synchronous
  // primary-key read against a local SQLite file.
  const row = db
    .prepare(
      `SELECT r.id, r.org_id, r.email, r.name, o.tier
         FROM recruiters r
         JOIN organizations o ON o.id = r.org_id
        WHERE r.id = ?`
    )
    .get(payload.id);
  if (!row) return res.status(401).json({ error: 'Account no longer exists' });

  // Keep the camelCase `orgId` shape every route already reads.
  req.recruiter = {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    name: row.name,
    tier: row.tier
  };
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Demo accounts can browse their sample data but change nothing. Gating on the
// HTTP method rather than on a list of routes means any endpoint added later is
// covered automatically, without anyone having to remember to guard it.
function blockDemoWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (tierConfig(req.recruiter.tier).readOnly) {
    return res.status(403).json({
      code: 'DEMO_READ_ONLY',
      error: 'This is a read-only demo account. Everything you see is sample data.'
    });
  }
  next();
}

module.exports = { signToken, requireAuth, blockDemoWrites, SECRET };
