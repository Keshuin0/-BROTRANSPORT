import { Hono, type Context } from 'hono';
import { desc } from 'drizzle-orm';
import { createDb, agentActions } from '@bro/db';
import {
  AGENT_DIRECTORY,
  AgentActionDecisionSchema,
  AgentChatRequestSchema,
  AgentIdSchema,
  RoleAccessError,
  canAccessAgent,
  getAgentsForRole,
  isOpsRole,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import {
  executeApprovedAgentAction,
  runExecutiveChiefOfStaffCorrelation,
  runSpecialistCopilotTurn,
} from '../../services/aiCopilot.js';

export const agentRoutes = new Hono<ApiEnv>();

agentRoutes.get('/agents/directory', (c) => {
  const user = c.get('user');
  const role = user?.role ?? 'visitor';
  return c.json({
    role,
    authorizedAgents: getAgentsForRole(role),
    allAgents: Object.values(AGENT_DIRECTORY),
  });
});

agentRoutes.post('/agents/:agentId/chat', async (c) => {
  const user = c.get('user');
  if (!user || user.role === 'visitor') {
    return c.json({ error: 'Authentication required to invoke specialist agents.' }, 401);
  }

  const rawAgentId = c.req.param('agentId');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = AgentChatRequestSchema.safeParse({
    ...body,
    agentId: rawAgentId,
  });

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid agent chat request.' }, 400);
  }

  try {
    const result = await runSpecialistCopilotTurn(c.env, {
      user,
      input: parsed.data,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof RoleAccessError) {
      return c.json({ error: err.message }, 403);
    }
    console.error('[AGENT_CHAT_ERROR]', err);
    return c.json({ error: 'Specialist agent failed to process turn.' }, 500);
  }
});

agentRoutes.get('/agents/actions', async (c) => {
  const user = c.get('user');
  if (!user || user.role === 'visitor') {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  if (!c.env.DB) {
    return c.json({ actions: [] });
  }

  const db = createDb(c.env.DB);
  const statusFilter = c.req.query('status');
  const agentIdFilter = c.req.query('agentId');

  const rows = await db
    .select()
    .from(agentActions)
    .orderBy(desc(agentActions.createdAt))
    .limit(100);

  const scoped = rows.filter((row) => {
    if (statusFilter && row.status !== statusFilter) return false;
    if (agentIdFilter && row.agentId !== agentIdFilter) return false;

    if (user.role === 'super_admin' || user.role === 'executive') return true;
    if (user.role === 'shipper_user' || user.role === 'shipper_admin') {
      return Boolean(user.organizationId && row.organizationId === user.organizationId);
    }
    if (user.role === 'carrier_driver') {
      return row.targetUserId === user.id || row.targetRole === 'carrier_driver';
    }

    const parsedAgent = AgentIdSchema.safeParse(row.agentId);
    if (parsedAgent.success && canAccessAgent(user.role, parsedAgent.data)) {
      return true;
    }
    return row.targetRole === user.role;
  });

  return c.json({ actions: scoped });
});

async function handleActionDecision(
  c: Context<ApiEnv>,
  forcedDecision?: 'approve' | 'reject',
) {
  const user = c.get('user');
  if (!user || user.role === 'visitor') {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  const actionId = c.req.param('id');
  if (!actionId) {
    return c.json({ error: 'Action ID is required.' }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = AgentActionDecisionSchema.safeParse({
    ...body,
    ...(forcedDecision ? { decision: forcedDecision } : {}),
  });

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid decision payload.' }, 400);
  }

  try {
    const res = await executeApprovedAgentAction(c.env, {
      actionId,
      actor: user,
      decision: parsed.data.decision,
      notes: parsed.data.notes,
    });
    return c.json(res);
  } catch (err) {
    if (err instanceof RoleAccessError) {
      return c.json({ error: err.message }, 403);
    }
    const msg = err instanceof Error ? err.message : 'Unable to process agent action.';
    const status = msg.includes('not found') ? 404 : 400;
    return c.json({ error: msg }, status);
  }
}

agentRoutes.post('/agents/actions/:id/decision', (c) => handleActionDecision(c));
agentRoutes.post('/agents/actions/:id/approve', (c) => handleActionDecision(c, 'approve'));
agentRoutes.post('/agents/actions/:id/reject', (c) => handleActionDecision(c, 'reject'));

agentRoutes.get('/agents/hub/briefing', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) {
    return c.json({ error: 'Operations clearance required.' }, 403);
  }

  const correlation = await runExecutiveChiefOfStaffCorrelation(c.env);
  return c.json({
    success: true,
    ...correlation,
  });
});

agentRoutes.post('/agents/hub/correlate', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'executive' && user.role !== 'super_admin' && !isOpsRole(user.role))) {
    return c.json({ error: 'Operations clearance required.' }, 403);
  }

  const correlation = await runExecutiveChiefOfStaffCorrelation(c.env);
  return c.json({
    success: true,
    ...correlation,
  });
});
