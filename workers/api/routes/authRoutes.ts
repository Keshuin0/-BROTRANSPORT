import { Hono } from 'hono';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import {
  createDb,
  users,
  accounts,
  sessions,
  verifications,
  staffInvites,
  drivers,
  auditLogs,
  seedDatabase,
} from '@bro/db';
import {
  ActivateInviteSchema,
  ChangePasswordSchema,
  ROLE_LABELS,
  ResetPasswordConfirmSchema,
  ResetPasswordRequestSchema,
  defaultHomeForRole,
  type UserRole,
} from '@bro/contracts';
import type { CloudflareEnv, SessionUser } from '../../../src/env.js';
import {
  authenticateWithPassword,
  buildSessionCookie,
  createSessionForUser,
  issueEmailOtp,
  registerPasswordUser,
  resolveSessionFromCookie,
  revokeSession,
  sha256HexToken,
  verifyEmailOtp,
} from '../auth.js';
import { bytesToHex, checkRateLimit, hashPassword, verifyPassword } from '../security.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../../services/email.js';

export type ApiEnv = {
  Bindings: CloudflareEnv;
  Variables: {
    user: SessionUser | null;
    sessionId: string | null;
  };
};

const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

const RegisterSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  password: z.string().min(10, { error: 'Password must be at least 10 characters.' }),
  role: z.enum(['shipper_user', 'carrier_driver']).default('shipper_user'),
});

const OtpRequestSchema = z.object({ email: z.email() });
const OtpVerifySchema = z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/) });

export const authRoutes = new Hono<ApiEnv>();

async function enforceAuthRateLimit(
  c: { env: CloudflareEnv; req: { header: (name: string) => string | undefined } },
  actionKey: string,
  limit = 20,
  windowSec = 60,
): Promise<boolean> {
  const clientIp = c.req.header('CF-Connecting-IP') || 'local';
  const rl = await checkRateLimit(c.env?.CACHE, `auth:${actionKey}:${clientIp}`, limit, windowSec);
  return rl.allowed;
}

authRoutes.get('/me', (c) => {
  return c.json({ user: c.get('user') });
});

authRoutes.post('/register', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'register', 10, 60))) {
    return c.json({ error: 'Too many registration attempts. Please wait a minute and try again.' }, 429);
  }
  const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid registration data.' }, 400);
  }
  const db = createDb(c.env.DB);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email.trim().toLowerCase()))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: 'An account with this email already exists.' }, 409);
  }

  const user = await registerPasswordUser(c.env, parsed.data);
  const session = await createSessionForUser(c.env, user.id, {
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });
  const isProd = c.env.ENVIRONMENT === 'production';
  c.header('Set-Cookie', buildSessionCookie(session.token, isProd));
  return c.json({ success: true, user, redirectTo: defaultHomeForRole(user.role) }, 201);
});

authRoutes.post('/login', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'login', 15, 60))) {
    return c.json({ error: 'Too many sign-in attempts. Please wait a minute and try again.' }, 429);
  }
  const parsed = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Provide a valid email and password.' }, 400);
  }
  const user = await authenticateWithPassword(c.env, parsed.data.email, parsed.data.password);
  if (!user) {
    return c.json({ error: 'Invalid credentials or inactive account.' }, 401);
  }
  const session = await createSessionForUser(c.env, user.id, {
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });
  const isProd = c.env.ENVIRONMENT === 'production';
  c.header('Set-Cookie', buildSessionCookie(session.token, isProd));
  const redirectTo = user.mustChangePassword
    ? '/activate?mode=set-password'
    : defaultHomeForRole(user.role);
  return c.json({ success: true, user, redirectTo });
});

authRoutes.post('/otp/request', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'otp-request', 10, 60))) {
    return c.json({ error: 'Too many OTP requests. Please wait a minute before retrying.' }, 429);
  }
  const parsed = OtpRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Provide a valid email.' }, 400);

  const isProd = c.env?.ENVIRONMENT === 'production';
  const hasResendKey = Boolean(c.env?.RESEND_API_KEY?.trim());
  if (isProd && !hasResendKey) {
    return c.json({ error: 'Email delivery service is not configured for OTP verification.' }, 503);
  }

  const emailLower = parsed.data.email.trim().toLowerCase();
  const db = createDb(c.env.DB);
  const found = await db
    .select({ id: users.id, name: users.name, email: users.email, active: users.active })
    .from(users)
    .where(eq(users.email, emailLower))
    .limit(1);

  const targetUser = found[0];
  if (!targetUser || !targetUser.active) {
    // Do not leak user existence
    return c.json({ success: true, message: 'If an account exists, a 6-digit code was sent.' });
  }

  const { code } = await issueEmailOtp(c.env, targetUser.email);
  let emailSent = false;

  if (hasResendKey) {
    const emailRes = await sendOtpEmail(c.env, {
      to: targetUser.email,
      recipientName: targetUser.name,
      otpCode: code,
      expiresInMinutes: 10,
      purpose: 'Portal Sign-In Verification',
    });
    emailSent = emailRes.sent;
    if (!emailRes.sent) {
      console.error('[OTP_EMAIL_ERROR]', emailRes.error);
      if (isProd) {
        return c.json({ error: 'Unable to dispatch OTP email right now. Please try again shortly.' }, 502);
      }
    }
  }

  const isDev = !isProd;
  return c.json({
    success: true,
    message: emailSent ? '6-digit verification code sent via email.' : '6-digit verification code issued.',
    emailSent,
    ...(isDev ? { devCode: code } : {}),
  });
});

authRoutes.post('/otp/verify', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'otp-verify', 15, 60))) {
    return c.json({ error: 'Too many OTP verification attempts. Please wait a minute and try again.' }, 429);
  }
  const parsed = OtpVerifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid email or 6-digit code.' }, 400);

  const user = await verifyEmailOtp(c.env, parsed.data.email, parsed.data.code);
  if (!user) return c.json({ error: 'Invalid or expired security code.' }, 401);

  const session = await createSessionForUser(c.env, user.id, {
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });
  const isProd = c.env.ENVIRONMENT === 'production';
  c.header('Set-Cookie', buildSessionCookie(session.token, isProd));
  const redirectTo = user.mustChangePassword
    ? '/activate?mode=set-password'
    : defaultHomeForRole(user.role);
  return c.json({ success: true, user, redirectTo });
});

authRoutes.get('/invite-info', async (c) => {
  const rawToken = (c.req.query('token') || '').trim();
  if (!rawToken || rawToken.length < 16) {
    return c.json({ valid: false, error: 'Invite link is invalid or has expired.' }, 404);
  }

  const tokenHash = await sha256HexToken(rawToken);
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .limit(1);

  const invite = rows[0];
  const now = Date.now();
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
    return c.json({ valid: false, error: 'Invite link is invalid or has expired.' }, 404);
  }

  const role = invite.role as UserRole;
  return c.json({
    valid: true,
    email: invite.email,
    name: invite.name,
    role,
    roleLabel: ROLE_LABELS[role] ?? role,
    title: invite.title ?? null,
    expiresAt: invite.expiresAt,
  });
});

authRoutes.post('/activate', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'activate', 10, 60))) {
    return c.json({ error: 'Too many activation attempts. Please wait a minute and try again.' }, 429);
  }
  const parsed = ActivateInviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Valid invite token and password required.' }, 400);
  }

  const tokenHash = await sha256HexToken(parsed.data.token);
  const db = createDb(c.env.DB);
  const inviteRows = await db
    .select()
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .limit(1);

  const invite = inviteRows[0];
  const now = Date.now();
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
    return c.json({ error: 'Invite link is invalid, revoked, or has expired.' }, 404);
  }

  const emailLower = invite.email.trim().toLowerCase();
  const passwordHash = await hashPassword(parsed.data.password);
  const assignedRole = invite.role as UserRole;

  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, emailLower))
    .limit(1);

  let userId: string;
  if (existingUsers[0]) {
    userId = existingUsers[0].id;
    await db
      .update(users)
      .set({
        name: invite.name,
        role: assignedRole,
        title: invite.title ?? existingUsers[0].title ?? null,
        organizationId: invite.organizationId ?? existingUsers[0].organizationId ?? null,
        invitedByUserId: invite.invitedByUserId ?? existingUsers[0].invitedByUserId ?? null,
        emailVerified: true,
        mustChangePassword: false,
        active: true,
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
  } else {
    userId = `usr_${crypto.randomUUID()}`;
    await db.insert(users).values({
      id: userId,
      name: invite.name,
      email: emailLower,
      emailVerified: true,
      role: assignedRole,
      title: invite.title ?? null,
      organizationId: invite.organizationId ?? null,
      invitedByUserId: invite.invitedByUserId ?? null,
      mustChangePassword: false,
      lastLoginAt: now,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const existingAcc = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
    .limit(1);

  if (existingAcc[0]) {
    await db
      .update(accounts)
      .set({ password: passwordHash, accountId: emailLower, updatedAt: now })
      .where(eq(accounts.id, existingAcc[0].id));
  } else {
    await db.insert(accounts).values({
      id: `acc_${crypto.randomUUID()}`,
      accountId: emailLower,
      providerId: 'credential',
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (invite.driverId) {
    await db
      .update(drivers)
      .set({ userId, status: 'active', updatedAt: now })
      .where(eq(drivers.id, invite.driverId));
  }

  await db
    .update(staffInvites)
    .set({ acceptedAt: now })
    .where(eq(staffInvites.id, invite.id));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: userId,
    actorType: 'user',
    action: 'INVITE_ACTIVATED',
    entityType: 'staff_invite',
    entityId: invite.id,
    detailJson: JSON.stringify({
      email: emailLower,
      role: assignedRole,
      organizationId: invite.organizationId ?? null,
      driverId: invite.driverId ?? null,
    }),
    createdAt: now,
  });

  const sessionUser: SessionUser = {
    id: userId,
    name: invite.name,
    email: emailLower,
    role: assignedRole,
    organizationId: invite.organizationId ?? null,
    mustChangePassword: false,
    title: invite.title ?? null,
  };

  const session = await createSessionForUser(c.env, userId, {
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });
  const isProd = c.env.ENVIRONMENT === 'production';
  c.header('Set-Cookie', buildSessionCookie(session.token, isProd));
  return c.json({
    success: true,
    user: sessionUser,
    redirectTo: defaultHomeForRole(sessionUser.role),
  });
});

authRoutes.post('/password-reset/request', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'pwreset-request', 10, 60))) {
    return c.json({ error: 'Too many password reset requests. Please wait a minute and try again.' }, 429);
  }
  const parsed = ResetPasswordRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Provide a valid email address.' }, 400);
  }

  const isProd = c.env?.ENVIRONMENT === 'production';
  const isDev = !isProd;
  const hasResendKey = Boolean(c.env?.RESEND_API_KEY?.trim());
  const emailLower = parsed.data.email.trim().toLowerCase();
  const db = createDb(c.env.DB);

  const found = await db
    .select()
    .from(users)
    .where(eq(users.email, emailLower))
    .limit(1);

  const targetUser = found[0];
  if (!targetUser || !targetUser.active) {
    return c.json({
      success: true,
      message: 'If an active account exists, a password reset link was dispatched.',
    });
  }

  const now = Date.now();
  const rawToken = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256HexToken(rawToken);
  const expiresAt = now + 30 * 60_000;

  await db.insert(verifications).values({
    id: `pwr_${crypto.randomUUID()}`,
    identifier: `pwreset:${tokenHash}`,
    value: targetUser.id,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  const otp = await issueEmailOtp(c.env, targetUser.email);
  const baseUrl = (c.env.PUBLIC_APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;

  let emailSent = false;
  if (hasResendKey) {
    const emailRes = await sendPasswordResetEmail(c.env, {
      to: targetUser.email,
      recipientName: targetUser.name,
      resetUrl,
      otpCode: otp.code,
      expiresInMinutes: 30,
    });
    emailSent = emailRes.sent;
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: targetUser.id,
    actorType: 'user',
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'user',
    entityId: targetUser.id,
    detailJson: JSON.stringify({ emailSent }),
    createdAt: now,
  });

  return c.json({
    success: true,
    message: 'If an active account exists, a password reset link was dispatched.',
    emailSent,
    ...(isDev
      ? {
          devToken: rawToken,
          devOtpCode: otp.code,
          devResetUrl: `/reset-password?token=${rawToken}`,
        }
      : {}),
  });
});

authRoutes.post('/password-reset/confirm', async (c) => {
  if (!(await enforceAuthRateLimit(c, 'pwreset-confirm', 10, 60))) {
    return c.json({ error: 'Too many password reset confirmation attempts. Please wait a minute.' }, 429);
  }
  const parsed = ResetPasswordConfirmSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Provide a valid reset token and password.' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  const tokenOrOtp = parsed.data.tokenOrOtp.trim();
  let resolvedUser: SessionUser | null = null;

  if (/^\d{6}$/.test(tokenOrOtp) && parsed.data.email) {
    resolvedUser = await verifyEmailOtp(c.env, parsed.data.email, tokenOrOtp);
  } else {
    const tokenHash = await sha256HexToken(tokenOrOtp);
    const verRows = await db
      .select()
      .from(verifications)
      .where(and(eq(verifications.identifier, `pwreset:${tokenHash}`), gt(verifications.expiresAt, now)))
      .limit(1);

    const match = verRows[0];
    if (match) {
      await db.delete(verifications).where(eq(verifications.id, match.id));
      const userRows = await db.select().from(users).where(eq(users.id, match.value)).limit(1);
      const u = userRows[0];
      if (u && u.active) {
        resolvedUser = {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role as UserRole,
          organizationId: u.organizationId,
          mustChangePassword: false,
          title: u.title ?? null,
        };
      }
    }
  }

  if (!resolvedUser) {
    return c.json({ error: 'Invalid or expired password reset token.' }, 401);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const existingAcc = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, resolvedUser.id), eq(accounts.providerId, 'credential')))
    .limit(1);

  if (existingAcc[0]) {
    await db
      .update(accounts)
      .set({ password: passwordHash, accountId: resolvedUser.email, updatedAt: now })
      .where(eq(accounts.id, existingAcc[0].id));
  } else {
    await db.insert(accounts).values({
      id: `acc_${crypto.randomUUID()}`,
      accountId: resolvedUser.email,
      providerId: 'credential',
      userId: resolvedUser.id,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db
    .update(users)
    .set({
      emailVerified: true,
      mustChangePassword: false,
      lastLoginAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, resolvedUser.id));

  await db.delete(sessions).where(eq(sessions.userId, resolvedUser.id));

  const session = await createSessionForUser(c.env, resolvedUser.id, {
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });
  const isProd = c.env.ENVIRONMENT === 'production';
  c.header('Set-Cookie', buildSessionCookie(session.token, isProd));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: resolvedUser.id,
    actorType: 'user',
    action: 'PASSWORD_RESET_COMPLETED',
    entityType: 'user',
    entityId: resolvedUser.id,
    detailJson: JSON.stringify({ email: resolvedUser.email }),
    createdAt: now,
  });

  const finalUser: SessionUser = { ...resolvedUser, mustChangePassword: false };
  return c.json({
    success: true,
    user: finalUser,
    redirectTo: defaultHomeForRole(finalUser.role),
  });
});

authRoutes.post('/change-password', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  const parsed = ChangePasswordSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Valid new password required.' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  const existingAcc = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
    .limit(1);

  const acc = existingAcc[0];
  if (!user.mustChangePassword && acc?.password) {
    if (!parsed.data.currentPassword) {
      return c.json({ error: 'Current password is required to change your password.' }, 400);
    }
    const valid = await verifyPassword(parsed.data.currentPassword, acc.password);
    if (!valid) {
      return c.json({ error: 'Current password is incorrect.' }, 401);
    }
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  if (acc) {
    await db
      .update(accounts)
      .set({ password: passwordHash, updatedAt: now })
      .where(eq(accounts.id, acc.id));
  } else {
    await db.insert(accounts).values({
      id: `acc_${crypto.randomUUID()}`,
      accountId: user.email,
      providerId: 'credential',
      userId: user.id,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db
    .update(users)
    .set({ mustChangePassword: false, updatedAt: now })
    .where(eq(users.id, user.id));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'USER_PASSWORD_CHANGED',
    entityType: 'user',
    entityId: user.id,
    detailJson: JSON.stringify({ rotatedFromTempPassword: Boolean(user.mustChangePassword) }),
    createdAt: now,
  });

  return c.json({
    success: true,
    redirectTo: defaultHomeForRole(user.role),
  });
});

async function clearAuthSession(c: {
  env: CloudflareEnv;
  req: { header: (name: string) => string | undefined };
  header: (name: string, value: string) => void;
}) {
  const { sessionId } = await resolveSessionFromCookie(c.env, c.req.header('cookie'));
  if (sessionId && c.env?.DB) {
    await revokeSession(c.env, sessionId);
  }
  const isProd = c.env?.ENVIRONMENT === 'production';
  c.header('Set-Cookie', buildSessionCookie('', isProd, true));
}

authRoutes.get('/logout', async (c) => {
  await clearAuthSession(c);
  return c.redirect('/login', 302);
});

authRoutes.post('/logout', async (c) => {
  await clearAuthSession(c);
  const accept = c.req.header('Accept') || '';
  if (accept.includes('text/html')) {
    return c.redirect('/login', 302);
  }
  return c.json({ success: true });
});

/** Local-development-only seeded persona switcher — strictly returns 404 in production! */
authRoutes.post('/dev-impersonate', async (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ error: 'Not Found' }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  if (!body.email) return c.json({ error: 'Email required.' }, 400);

  const db = createDb(c.env.DB);
  await seedDatabase(db);
  const found = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email.trim().toLowerCase()))
    .limit(1);
  const u = found[0];
  if (!u) return c.json({ error: 'Seeded demo user not found.' }, 404);

  const session = await createSessionForUser(c.env, u.id);
  c.header('Set-Cookie', buildSessionCookie(session.token, false));
  return c.json({
    success: true,
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role as UserRole,
      organizationId: u.organizationId,
      mustChangePassword: Boolean(u.mustChangePassword),
      title: u.title ?? null,
    },
    redirectTo: defaultHomeForRole(u.role as UserRole),
  });
});
