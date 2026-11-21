import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createDb,
  users,
  accounts,
  organizations,
  staffInvites,
  auditLogs,
  seedDatabase,
} from '@bro/db';
import {
  AdminCreateUserSchema,
  ROLE_LABELS,
  StaffInviteCreateSchema,
  UserRoleSchema,
  isOpsRole,
  type UserRole,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { sha256HexToken } from '../auth.js';
import { bytesToHex, hashPassword } from '../security.js';
import { sendStaffInviteEmail } from '../../services/email.js';

export const opsAdminRoutes = new Hono<ApiEnv>();

const CopilotCommandSchema = z.object({
  command: z.string().trim().min(1, { error: 'Command string required.' }).max(500),
});

const AdminUpdateUserRoleSchema = z.object({
  role: UserRoleSchema,
  active: z.boolean().optional(),
  organizationId: z.string().trim().max(80).nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
});

const AgentActionSchema = z.object({
  action: z.enum(['toggle', 'run']),
  enabled: z.boolean().optional(),
});

async function ensureInternalOrgExists(db: ReturnType<typeof createDb>, orgId: string, now: number) {
  if (orgId === 'org_bro_internal') {
    await db
      .insert(organizations)
      .values({
        id: 'org_bro_internal',
        name: '#BRO Transport Corp.',
        type: 'internal',
        scac: 'BROP',
        carmRppVerified: true,
        currency: 'CAD',
        paymentTermsDays: 30,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

opsAdminRoutes.post('/ops/copilot/command', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const parsed = CopilotCommandSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Command string required.' }, 400);
  }
  const command = parsed.data.command;

  if (c.env.DISPATCH_AGENT) {
    const id = c.env.DISPATCH_AGENT.idFromName('global-dispatch-copilot');
    const stub = c.env.DISPATCH_AGENT.get(id);
    const res = await stub.fetch('https://agent.internal/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const data = await res.json().catch(() => ({ error: 'Copilot agent returned invalid response.' }));
    return c.json(data, res.ok ? 200 : 502);
  }

  return c.json({
    intent: 'DISPATCH_BOARD',
    requiresConfirmation: false,
    suggestedRoute: '/ops/dispatch',
    summary: `Command processed deterministically: ${command}`,
  });
});

opsAdminRoutes.use('/ops/admin/*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'super_admin') {
    return c.json({ error: 'Super Admin privileges required.' }, 403);
  }
  await next();
});

opsAdminRoutes.get('/ops/admin/users', async (c) => {
  const db = createDb(c.env.DB);
  const [userRows, inviteRows, orgRows] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        title: users.title,
        organizationId: users.organizationId,
        mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
        emailVerified: users.emailVerified,
        active: users.active,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(100),
    db
      .select({
        id: staffInvites.id,
        email: staffInvites.email,
        name: staffInvites.name,
        role: staffInvites.role,
        title: staffInvites.title,
        organizationId: staffInvites.organizationId,
        driverId: staffInvites.driverId,
        invitedByUserId: staffInvites.invitedByUserId,
        expiresAt: staffInvites.expiresAt,
        acceptedAt: staffInvites.acceptedAt,
        revokedAt: staffInvites.revokedAt,
        createdAt: staffInvites.createdAt,
      })
      .from(staffInvites)
      .orderBy(desc(staffInvites.createdAt))
      .limit(100),
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        type: organizations.type,
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt))
      .limit(100),
  ]);

  return c.json({
    users: userRows,
    invites: inviteRows,
    organizations: orgRows,
  });
});

opsAdminRoutes.post('/ops/admin/users/invite', async (c) => {
  const admin = c.get('user')!;
  const parsed = StaffInviteCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid staff invite parameters.' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  const orgId = parsed.data.organizationId || 'org_bro_internal';
  await ensureInternalOrgExists(db, orgId, now);

  const rawToken = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256HexToken(rawToken);
  const inviteId = `inv_${crypto.randomUUID()}`;
  const emailLower = parsed.data.email.trim().toLowerCase();
  const expiresAt = now + 48 * 3600_000;

  await db.insert(staffInvites).values({
    id: inviteId,
    email: emailLower,
    name: parsed.data.name,
    role: parsed.data.role,
    title: parsed.data.title ?? null,
    organizationId: orgId,
    driverId: parsed.data.driverId ?? null,
    tokenHash,
    invitedByUserId: admin.id,
    expiresAt,
    createdAt: now,
  });

  const baseUrl = (c.env.PUBLIC_APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  const activateUrl = `${baseUrl}/activate?token=${rawToken}`;
  const roleLabel = ROLE_LABELS[parsed.data.role as UserRole] ?? parsed.data.role;

  let emailSent = false;
  if (c.env?.RESEND_API_KEY?.trim()) {
    const emailRes = await sendStaffInviteEmail(c.env, {
      to: emailLower,
      recipientName: parsed.data.name,
      roleLabel,
      title: parsed.data.title ?? null,
      invitedByName: admin.name,
      activateUrl,
      expiresInHours: 48,
    });
    emailSent = emailRes.sent;
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: admin.id,
    actorType: 'user',
    action: 'ADMIN_STAFF_INVITED',
    entityType: 'staff_invite',
    entityId: inviteId,
    detailJson: JSON.stringify({
      email: emailLower,
      role: parsed.data.role,
      title: parsed.data.title ?? null,
      organizationId: orgId,
      emailSent,
    }),
    createdAt: now,
  });

  return c.json(
    {
      success: true,
      inviteId,
      activateUrl: `${baseUrl}/activate?token=${rawToken}`,
      relativeActivateUrl: `/activate?token=${rawToken}`,
      emailSent,
    },
    201,
  );
});

opsAdminRoutes.post('/ops/admin/users/create', async (c) => {
  const admin = c.get('user')!;
  const parsed = AdminCreateUserSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid user creation payload.' }, 400);
  }

  const db = createDb(c.env.DB);
  const emailLower = parsed.data.email.trim().toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, emailLower))
    .limit(1);

  if (existing[0]) {
    return c.json({ error: 'An account with this email address already exists.' }, 409);
  }

  const now = Date.now();
  const orgId = parsed.data.organizationId || 'org_bro_internal';
  await ensureInternalOrgExists(db, orgId, now);

  const userId = `usr_${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(parsed.data.tempPassword);

  await db.insert(users).values({
    id: userId,
    name: parsed.data.name,
    email: emailLower,
    emailVerified: true,
    role: parsed.data.role,
    title: parsed.data.title ?? null,
    organizationId: orgId,
    invitedByUserId: admin.id,
    mustChangePassword: true,
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
    actorUserId: admin.id,
    actorType: 'user',
    action: 'ADMIN_USER_CREATED_TEMP_PASSWORD',
    entityType: 'user',
    entityId: userId,
    detailJson: JSON.stringify({
      email: emailLower,
      role: parsed.data.role,
      title: parsed.data.title ?? null,
      organizationId: orgId,
      mustChangePassword: true,
    }),
    createdAt: now,
  });

  return c.json(
    {
      success: true,
      user: {
        id: userId,
        name: parsed.data.name,
        email: emailLower,
        role: parsed.data.role,
        title: parsed.data.title ?? null,
        organizationId: orgId,
        mustChangePassword: true,
        active: true,
      },
    },
    201,
  );
});

opsAdminRoutes.post('/ops/admin/invites/:id/revoke', async (c) => {
  const admin = c.get('user')!;
  const inviteId = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(staffInvites)
    .where(eq(staffInvites.id, inviteId))
    .limit(1);

  const invite = rows[0];
  if (!invite) {
    return c.json({ error: 'Staff invite not found.' }, 404);
  }

  const now = Date.now();
  await db
    .update(staffInvites)
    .set({ revokedAt: now })
    .where(eq(staffInvites.id, inviteId));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: admin.id,
    actorType: 'user',
    action: 'ADMIN_STAFF_INVITE_REVOKED',
    entityType: 'staff_invite',
    entityId: inviteId,
    detailJson: JSON.stringify({ email: invite.email, role: invite.role }),
    createdAt: now,
  });

  return c.json({ success: true, id: inviteId, revokedAt: now });
});

opsAdminRoutes.post('/ops/admin/invites/:id/resend', async (c) => {
  const admin = c.get('user')!;
  const inviteId = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(staffInvites)
    .where(eq(staffInvites.id, inviteId))
    .limit(1);

  const invite = rows[0];
  if (!invite) {
    return c.json({ error: 'Staff invite not found.' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'This invite has already been accepted.' }, 400);
  }

  const now = Date.now();
  const rawToken = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256HexToken(rawToken);
  const expiresAt = now + 48 * 3600_000;

  await db
    .update(staffInvites)
    .set({
      tokenHash,
      expiresAt,
      revokedAt: null,
    })
    .where(eq(staffInvites.id, inviteId));

  const baseUrl = (c.env.PUBLIC_APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  const activateUrl = `${baseUrl}/activate?token=${rawToken}`;
  const roleLabel = ROLE_LABELS[invite.role as UserRole] ?? invite.role;

  let emailSent = false;
  if (c.env?.RESEND_API_KEY?.trim()) {
    const emailRes = await sendStaffInviteEmail(c.env, {
      to: invite.email,
      recipientName: invite.name,
      roleLabel,
      title: invite.title ?? null,
      invitedByName: admin.name,
      activateUrl,
      expiresInHours: 48,
    });
    emailSent = emailRes.sent;
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: admin.id,
    actorType: 'user',
    action: 'ADMIN_STAFF_INVITE_RESENT',
    entityType: 'staff_invite',
    entityId: inviteId,
    detailJson: JSON.stringify({ email: invite.email, role: invite.role, emailSent }),
    createdAt: now,
  });

  return c.json({
    success: true,
    inviteId,
    activateUrl,
    relativeActivateUrl: `/activate?token=${rawToken}`,
    emailSent,
    expiresAt,
  });
});

opsAdminRoutes.patch('/ops/admin/users/:id/role', async (c) => {
  const admin = c.get('user')!;
  const targetId = c.req.param('id');
  const parsed = AdminUpdateUserRoleSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid role or active status.' }, 400);
  }

  const db = createDb(c.env.DB);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).limit(1);
  if (!existing[0]) {
    return c.json({ error: 'Target user not found.' }, 404);
  }

  const now = Date.now();
  const nextOrgId =
    parsed.data.organizationId !== undefined
      ? parsed.data.organizationId && parsed.data.organizationId.length > 0
        ? parsed.data.organizationId
        : null
      : undefined;
  if (nextOrgId) {
    await ensureInternalOrgExists(db, nextOrgId, now);
  }
  const nextTitle =
    parsed.data.title !== undefined
      ? parsed.data.title && parsed.data.title.length > 0
        ? parsed.data.title
        : null
      : undefined;

  await db
    .update(users)
    .set({
      role: parsed.data.role,
      ...(typeof parsed.data.active === 'boolean' ? { active: parsed.data.active } : {}),
      ...(nextOrgId !== undefined ? { organizationId: nextOrgId } : {}),
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      updatedAt: now,
    })
    .where(eq(users.id, targetId));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: admin.id,
    actorType: 'user',
    action: 'ADMIN_ROLE_UPDATED',
    entityType: 'user',
    entityId: targetId,
    detailJson: JSON.stringify({
      role: parsed.data.role,
      active: parsed.data.active,
      organizationId: nextOrgId,
      title: nextTitle,
    }),
    createdAt: now,
  });

  return c.json({
    success: true,
    id: targetId,
    role: parsed.data.role,
    organizationId: nextOrgId,
    title: nextTitle,
  });
});

opsAdminRoutes.get('/ops/admin/audit-logs', async (c) => {
  const db = createDb(c.env.DB);
  const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
  return c.json({ logs });
});

opsAdminRoutes.get('/ops/admin/agents/status', async (c) => {
  const results: Array<Record<string, unknown>> = [];

  const fetchDo = async (ns: DurableObjectNamespace | undefined, name: string, label: string) => {
    if (!ns) {
      results.push({ agent: label, enabled: true, mode: 'local_unmapped', lastRunAt: null, findingsCount: 0 });
      return;
    }
    try {
      const stub = ns.get(ns.idFromName(name));
      const r = await stub.fetch('https://agent.internal/status');
      const json = (await r.json().catch(() => ({ agent: label, enabled: false, error: 'Malformed status' }))) as Record<string, unknown>;
      results.push(json);
    } catch {
      results.push({ agent: label, enabled: false, error: 'Unreachable' });
    }
  };

  await Promise.all([
    fetchDo(c.env.CUSTOMS_AGENT, 'global-customs-agent', 'CustomsPreFlightAgent'),
    fetchDo(c.env.WATCHDOG_AGENT, 'global-watchdog-agent', 'FleetWatchdogAgent'),
    fetchDo(c.env.DISPATCH_AGENT, 'global-dispatch-copilot', 'DispatchCopilotAgent'),
  ]);

  results.push(
    { agent: 'DocumentProcessingWorkflow', type: 'Cloudflare Workflow', hitlThreshold: 0.92, enabled: true },
    { agent: 'BillingSettlementWorkflow', type: 'Cloudflare Workflow', hitlVarianceGate: '$0.01', enabled: true },
  );

  return c.json({ agents: results });
});

opsAdminRoutes.post('/ops/admin/agents/:name/action', async (c) => {
  const admin = c.get('user')!;
  const name = c.req.param('name');
  const parsed = AgentActionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Action must be "toggle" or "run".' }, 400);
  }
  const body = parsed.data;

  const map: Record<string, { ns?: DurableObjectNamespace; key: string }> = {
    CustomsPreFlightAgent: { ns: c.env.CUSTOMS_AGENT, key: 'global-customs-agent' },
    FleetWatchdogAgent: { ns: c.env.WATCHDOG_AGENT, key: 'global-watchdog-agent' },
  };
  const target = map[name];
  if (!target) return c.json({ error: 'Unknown controllable agent.' }, 404);

  let payload: unknown = { agent: name, action: body.action, mode: 'local_noop' };
  if (target.ns) {
    const stub = target.ns.get(target.ns.idFromName(target.key));
    const path = body.action === 'run' ? '/run' : '/toggle';
    const res = await stub.fetch(`https://agent.internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: body.enabled }),
    });
    payload = await res.json().catch(() => ({ agent: name, action: body.action }));
  }

  const db = createDb(c.env.DB);
  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: admin.id,
    actorType: 'user',
    action: `AGENT_${body.action.toUpperCase()}`,
    entityType: 'agent',
    entityId: name,
    detailJson: JSON.stringify(body),
    createdAt: Date.now(),
  });

  return c.json({ success: true, result: payload });
});

opsAdminRoutes.post('/ops/admin/bootstrap-seed', async (c) => {
  const admin = c.get('user')!;
  const db = createDb(c.env.DB);
  await seedDatabase(db);
  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: admin.id,
    actorType: 'user',
    action: 'ADMIN_BOOTSTRAP_SEED_EXECUTED',
    entityType: 'system',
    entityId: 'brotransport-db',
    detailJson: JSON.stringify({ initiatedBy: admin.email }),
    createdAt: Date.now(),
  });
  return c.json({
    success: true,
    message: 'Commercial fleet, drivers, corridors, customs manifests, and audit baseline initialized safely.',
  });
});
