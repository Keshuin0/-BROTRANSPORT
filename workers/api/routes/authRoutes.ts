import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, users, seedDatabase } from '@bro/db';
import { defaultHomeForRole, type UserRole } from '@bro/contracts';
import type { CloudflareEnv, SessionUser } from '../../../src/env.js';
import {
  authenticateWithPassword,
  buildSessionCookie,
  createSessionForUser,
  issueEmailOtp,
  registerPasswordUser,
  resolveSessionFromCookie,
  revokeSession,
  verifyEmailOtp,
} from '../auth.js';
import { sendOtpEmail } from '../../services/email.js';

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

authRoutes.get('/me', (c) => {
  return c.json({ user: c.get('user') });
});

authRoutes.post('/register', async (c) => {
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
  return c.json({ success: true, user, redirectTo: defaultHomeForRole(user.role) });
});

authRoutes.post('/otp/request', async (c) => {
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
  return c.json({ success: true, user, redirectTo: defaultHomeForRole(user.role) });
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
    user: { id: u.id, name: u.name, email: u.email, role: u.role as UserRole, organizationId: u.organizationId },
    redirectTo: defaultHomeForRole(u.role as UserRole),
  });
});
