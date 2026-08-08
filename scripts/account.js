// Admin account provisioning.
//
// There is no self-serve sign-up in the UI — accounts are created here and the
// credentials handed to the customer directly. This is also the only way to set
// or change an account's tier, since nothing in the app exposes that.
//
// Runs inside the container (node:sqlite needs Node >= 22.5):
//
//   docker compose exec app npm run account -- list
//   docker compose exec app npm run account -- create --email a@b.co --password s3cret --name "Ada" --org "Acme" --tier free
//   docker compose exec app npm run account -- set-tier --email a@b.co --tier demo
//   docker compose exec app npm run account -- set-password --email a@b.co --password newpw
//
// Tiers: demo (view-only) | free (5 forms, 20 responses each) | full (uncapped).

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../server/db');
const { TIERS } = require('../server/tiers');

const TIER_NAMES = Object.keys(TIERS);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return args;
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function requireArg(args, name) {
  const v = args[name];
  if (!v || v === true) die(`--${name} is required`);
  return String(v);
}

function checkTier(tier) {
  if (!TIER_NAMES.includes(tier)) {
    die(`Unknown tier "${tier}". Use one of: ${TIER_NAMES.join(', ')}`);
  }
  return tier;
}

function findRecruiter(email) {
  return db
    .prepare(
      `SELECT r.id, r.email, r.name, r.org_id, o.name AS org_name, o.tier
         FROM recruiters r JOIN organizations o ON o.id = r.org_id
        WHERE r.email = ?`
    )
    .get(email.toLowerCase());
}

function list() {
  const rows = db
    .prepare(
      `SELECT r.email, r.name, o.name AS org_name, o.tier,
              (SELECT COUNT(*) FROM forms f WHERE f.org_id = o.id) AS forms
         FROM recruiters r JOIN organizations o ON o.id = r.org_id
        ORDER BY o.tier, r.email`
    )
    .all();
  if (!rows.length) return console.log('\n  No accounts yet.\n');
  console.log('');
  console.log(`  ${'EMAIL'.padEnd(30)} ${'TIER'.padEnd(6)} ${'FORMS'.padEnd(6)} ORGANIZATION`);
  for (const r of rows) {
    const cap = TIERS[r.tier] ? TIERS[r.tier].maxForms : Infinity;
    const forms = cap === Infinity ? String(r.forms) : `${r.forms}/${cap}`;
    console.log(`  ${r.email.padEnd(30)} ${String(r.tier).padEnd(6)} ${forms.padEnd(6)} ${r.org_name}`);
  }
  console.log('');
}

function create(args) {
  const email = requireArg(args, 'email').toLowerCase();
  const password = requireArg(args, 'password');
  const name = args.name && args.name !== true ? String(args.name) : email.split('@')[0];
  const orgName = args.org && args.org !== true ? String(args.org) : name;
  const tier = checkTier(args.tier && args.tier !== true ? String(args.tier) : 'free');

  if (password.length < 8) die('Password must be at least 8 characters');
  if (findRecruiter(email)) die(`An account already exists for ${email}`);

  const orgId = crypto.randomUUID();
  const recruiterId = crypto.randomUUID();
  const now = Date.now();

  db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, created_at, tier) VALUES (?, ?, ?, ?)')
      .run(orgId, orgName, now, tier);
    db.prepare(
      'INSERT INTO recruiters (id, org_id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(recruiterId, orgId, email, bcrypt.hashSync(password, 10), name, now);
  });

  console.log(`\n  Created ${email} (${tier} tier) in "${orgName}".`);
  console.log(`  Share these credentials directly — there is no sign-up or reset flow.\n`);
}

function setTier(args) {
  const email = requireArg(args, 'email').toLowerCase();
  const tier = checkTier(requireArg(args, 'tier'));
  const account = findRecruiter(email);
  if (!account) die(`No account found for ${email}`);

  db.prepare('UPDATE organizations SET tier = ? WHERE id = ?').run(tier, account.org_id);
  // Tier is read per-request, not carried in the JWT, so this takes effect on
  // the account's very next request — no re-login needed.
  console.log(`\n  ${email}: ${account.tier} -> ${tier} (effective immediately)\n`);
}

function setPassword(args) {
  const email = requireArg(args, 'email').toLowerCase();
  const password = requireArg(args, 'password');
  if (password.length < 8) die('Password must be at least 8 characters');
  const account = findRecruiter(email);
  if (!account) die(`No account found for ${email}`);

  db.prepare('UPDATE recruiters SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), account.id);
  console.log(`\n  Password reset for ${email}.\n`);
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (command) {
  case 'list': list(); break;
  case 'create': create(args); break;
  case 'set-tier': setTier(args); break;
  case 'set-password': setPassword(args); break;
  default:
    console.log(`
  Usage: npm run account -- <command> [options]

    list
    create       --email <e> --password <p> [--name <n>] [--org <o>] [--tier ${TIER_NAMES.join('|')}]
    set-tier     --email <e> --tier <${TIER_NAMES.join('|')}>
    set-password --email <e> --password <p>
`);
    process.exit(command ? 1 : 0);
}
