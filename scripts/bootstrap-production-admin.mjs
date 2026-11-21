#!/usr/bin/env node
/**
 * #BRO Transport — Zero-Trust Production Super Admin Bootstrap Generator
 *
 * Generates idempotent Cloudflare D1 SQL with a Web Crypto PBKDF2-SHA256
 * (100,000 iterations) credential hash matching `workers/api/security.ts`
 * (`pbkdf2_sha256:100000:<saltHex>:<hashHex>`).
 *
 * Usage:
 *   node scripts/bootstrap-production-admin.mjs --email admin@brotransport.com --password "YourStrongPassword!2026"
 */

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateCsprngPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const rand = new Uint32Array(length);
  crypto.getRandomValues(rand);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[rand[i] % alphabet.length];
  }
  return out;
}

async function hashPasswordPbkdf2(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return `pbkdf2_sha256:100000:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(derived))}`;
}

function escapeSqlString(str) {
  return String(str).replace(/'/g, "''");
}

function parseArgs(argv) {
  const out = {
    email: 'admin@brotransport.com',
    name: 'Keshav Operations Admin',
    title: 'Operations & Platform Admin',
    password: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email' && argv[i + 1]) {
      out.email = argv[++i].trim().toLowerCase();
    } else if (arg === '--name' && argv[i + 1]) {
      out.name = argv[++i].trim();
    } else if (arg === '--title' && argv[i + 1]) {
      out.title = argv[++i].trim();
    } else if (arg === '--password' && argv[i + 1]) {
      out.password = argv[++i];
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const generated = !args.password;
  const password = args.password || generateCsprngPassword(20);

  if (password.length < 10) {
    console.error('Error: --password must be at least 10 characters.');
    process.exit(1);
  }

  const hash = await hashPasswordPbkdf2(password);
  const now = Date.now();
  const safeEmail = escapeSqlString(args.email);
  const safeName = escapeSqlString(args.name);
  const safeTitle = escapeSqlString(args.title);
  const safeHash = escapeSqlString(hash);

  const sql = [
    `INSERT INTO organizations (id, name, type, scac, carm_rpp_verified, currency, payment_terms_days, status, created_at, updated_at) VALUES ('org_bro_internal', '#BRO Transport Corp.', 'internal', 'BROP', 1, 'CAD', 30, 'active', ${now}, ${now}) ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO users (id, name, email, email_verified, role, organization_id, title, must_change_password, active, created_at, updated_at) VALUES ('usr_admin_01', '${safeName}', '${safeEmail}', 1, 'super_admin', 'org_bro_internal', '${safeTitle}', 0, 1, ${now}, ${now}) ON CONFLICT(email) DO UPDATE SET name = '${safeName}', role = 'super_admin', organization_id = 'org_bro_internal', title = '${safeTitle}', email_verified = 1, must_change_password = 0, active = 1, updated_at = ${now};`,
    `DELETE FROM accounts WHERE provider_id = 'credential' AND user_id = (SELECT id FROM users WHERE email = '${safeEmail}');`,
    `INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('acc_admin_prod_${crypto.randomUUID()}', '${safeEmail}', 'credential', (SELECT id FROM users WHERE email = '${safeEmail}'), '${safeHash}', ${now}, ${now});`,
  ].join('\n');

  console.log('# ====================================================================');
  console.log('# #BRO Transport — Production Super Admin D1 Bootstrap SQL');
  console.log('# ====================================================================');
  console.log(`# Email:    ${args.email}`);
  console.log(`# Role:     super_admin`);
  if (generated) {
    console.log(`# Generated CSPRNG Password: ${password}`);
  }
  console.log(`# PBKDF2:   ${hash}`);
  console.log('# --------------------------------------------------------------------\n');
  console.log(sql);
  console.log('\n# Execute against production D1 with:');
  console.log(
    `# npx wrangler d1 execute brotransport-db --remote --command "${sql.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
