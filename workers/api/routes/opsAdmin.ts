import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, users, auditLogs, seedDatabase } from '@bro/db';
import { UserRoleSchema, isOpsRole } from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';

export const opsAdminRoutes = new Hono<ApiEnv>();

opsAdminRoutes.post('/ops/copilot/command', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { command?: string };
  const command = (body.command || '').trim();
  if (!command) return c.json({ error: 'Command string required.' }, 400);

  if (c.env.DISPATCH_AGENT) {
    const id = c.env.DISPATCH_AGENT.idFromName('global-dispatch-copilot');
    const stub = c.env.DISPATCH_AGENT.get(id);
    const res = await stub.fetch('https://agent.internal/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    return c.json(await res.json());
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
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(100);
  return c.json({ users: rows });
});

opsAdminRoutes.patch('/ops/admin/users/:id/role', async (c) => {
  const admin = c.get('user')!;
  const targetId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { role?: string; active?: boolean };
  const parsedRole = UserRoleSchema.safeParse(body.role);
  if (!parsedRole.success) return c.json({ error: 'Invalid role value.' }, 400);

  const db = createDb(c.env.DB);
  const now = Date.now();
  await db
    .update(users)
    .set({
      role: parsedRole.data,
      ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
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
    detailJson: JSON.stringify({ role: parsedRole.data, active: body.active }),
    createdAt: now,
  });

  return c.json({ success: true, id: targetId, role: parsedRole.data });
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
      results.push((await r.json()) as Record<string, unknown>);
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
  const body = (await c.req.json().catch(() => ({}))) as { action: 'toggle' | 'run'; enabled?: boolean };

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
    payload = await res.json();
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
