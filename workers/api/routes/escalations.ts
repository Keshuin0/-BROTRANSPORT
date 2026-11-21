import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, escalations, shiftHandoffs, loads, auditLogs } from '@bro/db';
import {
  EscalationCreateSchema,
  ShiftHandoffCreateSchema,
  canAccessRoute,
  hasPermission,
  isOpsRole,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { emitHubEvent } from '../../agents/hubEvents.js';
import { checkRateLimit } from '../security.js';
import { sendEscalationEmail } from '../../services/email.js';

export const escalationRoutes = new Hono<ApiEnv>();

escalationRoutes.post('/escalations', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const rl = await checkRateLimit(c.env.CACHE, `esc:${ip}`, 10, 300);
  if (!rl.allowed) {
    return c.json({ error: 'Rate limit exceeded. Please wait before submitting another escalation.' }, 429);
  }

  const parsed = EscalationCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid escalation payload.' }, 400);
  }

  const now = Date.now();
  const id = `esc_${crypto.randomUUID()}`;
  const incidentRef = `BROP-ESC-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const slaDeadline = now + (parsed.data.severity === 'critical' ? 5 : 15) * 60_000;

  if (c.env.DB) {
    const db = createDb(c.env.DB);
    await db.insert(escalations).values({
      id,
      incidentRef,
      category: parsed.data.category,
      severity: parsed.data.severity,
      loadReference: parsed.data.loadReference ?? null,
      contactName: parsed.data.contactName,
      contactChannel: parsed.data.contactChannel,
      summary: parsed.data.summary,
      status: 'open',
      slaDeadline,
      createdAt: now,
    });

    await db.insert(auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      actorUserId: c.get('user')?.id ?? null,
      actorType: 'user',
      action: 'ESCALATION_CREATED',
      entityType: 'escalation',
      entityId: id,
      detailJson: JSON.stringify({ incidentRef, category: parsed.data.category }),
      createdAt: now,
    });
  }

  if (c.env.RESEND_API_KEY) {
    await sendEscalationEmail(c.env, {
      to: 'ops-watch@brotransport.com',
      ticketId: incidentRef,
      category: parsed.data.category,
      severity: parsed.data.severity,
      loadReference: parsed.data.loadReference,
      contactName: parsed.data.contactName,
      contactChannel: parsed.data.contactChannel,
      summary: parsed.data.summary,
    });
  }

  await emitHubEvent(c.env, {
    type: 'ESCALATION_CREATED',
    channel: 'ops:all',
    payload: {
      id,
      incidentRef,
      category: parsed.data.category,
      severity: parsed.data.severity,
      contactName: parsed.data.contactName,
      slaDeadline,
    },
  });

  return c.json({ success: true, id, incidentRef, slaDeadline }, 201);
});

escalationRoutes.get('/ops/escalations', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Forbidden' }, 403);
  const db = createDb(c.env.DB);
  const [rows, handoffRows, activeLoads] = await Promise.all([
    db.select().from(escalations).orderBy(desc(escalations.createdAt)).limit(50),
    db.select().from(shiftHandoffs).orderBy(desc(shiftHandoffs.createdAt)).limit(25),
    db.select().from(loads).orderBy(desc(loads.updatedAt)).limit(40),
  ]);
  return c.json({
    escalations: rows,
    handoffs: handoffRows,
    loads: activeLoads,
  });
});

escalationRoutes.patch('/ops/escalations/:id', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { status?: 'acknowledged' | 'resolved' };
  if (body.status !== 'acknowledged' && body.status !== 'resolved') {
    return c.json({ error: 'Status must be acknowledged or resolved.' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  await db
    .update(escalations)
    .set({
      status: body.status,
      assignedTo: user.id,
      resolvedAt: body.status === 'resolved' ? now : null,
    })
    .where(eq(escalations.id, id));

  return c.json({ success: true, id, status: body.status });
});

escalationRoutes.post('/ops/escalations/handoffs', async (c) => {
  const user = c.get('user');
  if (!user || (!canAccessRoute(user.role, '/ops/escalations') && !hasPermission(user.role, 'escalation:manage'))) {
    return c.json({ error: 'Night Coordinator, Dispatcher, Safety Officer, Executive, or Super Admin required.' }, 403);
  }

  const parsed = ShiftHandoffCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid shift handoff payload.' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  const id = `sh_${crypto.randomUUID()}`;

  await db.insert(shiftHandoffs).values({
    id,
    shiftWindow: parsed.data.shiftWindow,
    outgoingUserId: user.id,
    summaryMarkdown: parsed.data.summaryMarkdown,
    openEscalationIdsJson: JSON.stringify(parsed.data.openEscalationIds),
    createdAt: now,
  });

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'SHIFT_HANDOFF_PUBLISHED',
    entityType: 'shift_handoff',
    entityId: id,
    detailJson: JSON.stringify({
      shiftWindow: parsed.data.shiftWindow,
      openEscalationCount: parsed.data.openEscalationIds.length,
    }),
    createdAt: now,
  });

  return c.json({ success: true, id }, 201);
});
