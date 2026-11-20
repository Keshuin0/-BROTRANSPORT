import { eq, and, gt } from 'drizzle-orm';
import { createDb, users, sessions, accounts, verifications, auditLogs } from '@bro/db';
import type { UserRole } from '@bro/contracts';
import type { CloudflareEnv, SessionUser } from '../../src/env.js';
import { bytesToHex, hashPassword, verifyPassword, hmacSha256Hex } from './security.js';

export const SESSION_COOKIE_NAME = 'bro_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function buildSessionCookie(token: string, isProd: boolean, clear = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

function getAuthSecret(env: Partial<CloudflareEnv>): string {
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 16) {
    return env.BETTER_AUTH_SECRET;
  }
  if (env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test') {
    return 'dev-local-only-bro-transport-secret-key-2026';
  }
  throw new Error('BETTER_AUTH_SECRET must be configured in production.');
}

export async function createSessionForUser(
  env: CloudflareEnv,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ token: string; sessionId: string; expiresAt: number }> {
  const db = createDb(env.DB);
  const secret = getAuthSecret(env);
  const rawToken = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hmacSha256Hex(secret, rawToken);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const sessionId = `ses_${crypto.randomUUID()}`;

  await db.insert(sessions).values({
    id: sessionId,
    token: tokenHash,
    userId,
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent?.slice(0, 250) ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { token: rawToken, sessionId, expiresAt };
}

export async function resolveSessionFromCookie(
  env: CloudflareEnv | undefined,
  cookieHeader: string | null | undefined,
): Promise<{ user: SessionUser | null; sessionId: string | null }> {
  if (!env?.DB || !cookieHeader) return { user: null, sessionId: null };
  const cookies = parseCookieHeader(cookieHeader);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return { user: null, sessionId: null };

  try {
    const secret = getAuthSecret(env);
    const tokenHash = await hmacSha256Hex(secret, rawToken);
    const db = createDb(env.DB);
    const now = Date.now();

    const rows = await db
      .select({
        sessionId: sessions.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        organizationId: users.organizationId,
        active: users.active,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.token, tokenHash), gt(sessions.expiresAt, now)))
      .limit(1);

    const match = rows[0];
    if (!match || !match.active) return { user: null, sessionId: null };

    return {
      sessionId: match.sessionId,
      user: {
        id: match.userId,
        name: match.name,
        email: match.email,
        role: match.role as UserRole,
        organizationId: match.organizationId,
      },
    };
  } catch {
    return { user: null, sessionId: null };
  }
}

export async function revokeSession(env: CloudflareEnv, sessionId: string): Promise<void> {
  const db = createDb(env.DB);
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function registerPasswordUser(
  env: CloudflareEnv,
  params: { name: string; email: string; password: string; role?: UserRole; organizationId?: string | null },
): Promise<SessionUser> {
  const db = createDb(env.DB);
  const now = Date.now();
  const userId = `usr_${crypto.randomUUID()}`;
  const emailLower = params.email.trim().toLowerCase();
  const passwordHash = await hashPassword(params.password);
  const assignedRole: UserRole = params.role ?? 'shipper_user';

  await db.insert(users).values({
    id: userId,
    name: params.name.trim(),
    email: emailLower,
    emailVerified: false,
    role: assignedRole,
    organizationId: params.organizationId ?? null,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(accounts).values({
    id: `acc_${crypto.randomUUID()}`,
    accountId: emailLower,
    providerId: 'credential',
    userId,
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: userId,
    actorType: 'user',
    action: 'USER_REGISTERED',
    entityType: 'user',
    entityId: userId,
    detailJson: JSON.stringify({ role: assignedRole }),
    createdAt: now,
  });

  return {
    id: userId,
    name: params.name.trim(),
    email: emailLower,
    role: assignedRole,
    organizationId: params.organizationId ?? null,
  };
}

export async function authenticateWithPassword(
  env: CloudflareEnv,
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const db = createDb(env.DB);
  const emailLower = email.trim().toLowerCase();

  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      active: users.active,
      passwordHash: accounts.password,
    })
    .from(users)
    .innerJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential')))
    .where(eq(users.email, emailLower))
    .limit(1);

  const row = rows[0];
  if (!row || !row.active || !row.passwordHash) return null;

  const valid = await verifyPassword(password, row.passwordHash);
  if (!valid) return null;

  return {
    id: row.userId,
    name: row.name,
    email: row.email,
    role: row.role as UserRole,
    organizationId: row.organizationId,
  };
}

/** Issues a 6-digit cryptographically secure Email OTP stored hashed in D1 verifications. */
export async function issueEmailOtp(env: CloudflareEnv, email: string): Promise<{ code: string; expiresAt: number }> {
  const db = createDb(env.DB);
  const secret = getAuthSecret(env);
  const rand = new Uint32Array(1);
  crypto.getRandomValues(rand);
  const code = String(rand[0] % 1_000_000).padStart(6, '0');
  const now = Date.now();
  const expiresAt = now + 10 * 60_000;
  const emailLower = email.trim().toLowerCase();
  const hashed = await hmacSha256Hex(secret, `${emailLower}:${code}`);

  await db.insert(verifications).values({
    id: `otp_${crypto.randomUUID()}`,
    identifier: `otp:${emailLower}`,
    value: hashed,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  return { code, expiresAt };
}

export async function verifyEmailOtp(env: CloudflareEnv, email: string, code: string): Promise<SessionUser | null> {
  const db = createDb(env.DB);
  const secret = getAuthSecret(env);
  const emailLower = email.trim().toLowerCase();
  const hashed = await hmacSha256Hex(secret, `${emailLower}:${code.trim()}`);
  const now = Date.now();

  const matches = await db
    .select()
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, `otp:${emailLower}`),
        eq(verifications.value, hashed),
        gt(verifications.expiresAt, now),
      ),
    )
    .limit(1);

  if (matches.length === 0) return null;
  await db.delete(verifications).where(eq(verifications.id, matches[0].id));

  const userRows = await db.select().from(users).where(eq(users.email, emailLower)).limit(1);
  const u = userRows[0];
  if (!u || !u.active) return null;

  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as UserRole,
    organizationId: u.organizationId,
  };
}
