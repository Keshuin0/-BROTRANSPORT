import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createDb, drivers } from '@bro/db';
import { isOpsRole } from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { hmacSha256Hex, hexToBytes, timingSafeEqualBytes } from '../security.js';

export const wsRoutes = new Hono<ApiEnv>();

function getWsSecret(env: ApiEnv['Bindings']): string {
  return env.BETTER_AUTH_SECRET || (env.ENVIRONMENT === 'production' ? '' : 'dev-ws-ticket-secret-2026');
}

wsRoutes.post('/ws/ticket', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { channel?: string };
  const channel = body.channel || 'public:borders';
  const user = c.get('user');

  // Enforce strict RBAC on private WebSocket channels
  if (channel.startsWith('ops:')) {
    if (!user || !isOpsRole(user.role)) return c.json({ error: 'Forbidden channel' }, 403);
  } else if (channel.startsWith('org:')) {
    const orgId = channel.slice(4);
    if (!user || (!isOpsRole(user.role) && user.organizationId !== orgId)) {
      return c.json({ error: 'Forbidden channel' }, 403);
    }
  } else if (channel.startsWith('driver:')) {
    const driverId = channel.slice(7).trim();
    if (!user || !driverId || (user.role !== 'carrier_driver' && !isOpsRole(user.role))) {
      return c.json({ error: 'Forbidden channel' }, 403);
    }
    if (user.role === 'carrier_driver' && c.env.DB) {
      const db = createDb(c.env.DB);
      const matched = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(and(eq(drivers.id, driverId), eq(drivers.userId, user.id)))
        .limit(1);
      if (!matched[0]) {
        return c.json({ error: 'Forbidden channel' }, 403);
      }
    }
  } else if (channel !== 'public:borders') {
    return c.json({ error: 'Unknown WebSocket channel' }, 400);
  }

  const secret = getWsSecret(c.env);
  if (!secret) return c.json({ error: 'WebSocket signing key not configured.' }, 500);

  const exp = Math.floor(Date.now() / 1000) + 60;
  const sig = await hmacSha256Hex(secret, `${channel}:${exp}`);
  return c.json({ ticket: `${exp}.${sig}`, channel, expiresAt: exp * 1000 });
});

wsRoutes.get('/ws', async (c) => {
  const channel = c.req.query('channel') || 'public:borders';
  const ticket = c.req.query('ticket') || '';
  const [expStr, sigHex] = ticket.split('.');
  const exp = Number(expStr);
  const secret = getWsSecret(c.env);

  if (!secret || !expStr || !sigHex || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'Invalid or expired WebSocket ticket.' }, 401);
  }

  const expectedHex = await hmacSha256Hex(secret, `${channel}:${exp}`);
  const expectedBytes = hexToBytes(expectedHex);
  const providedBytes = hexToBytes(sigHex);
  if (!expectedBytes || !providedBytes || !timingSafeEqualBytes(expectedBytes, providedBytes)) {
    return c.json({ error: 'Invalid WebSocket ticket signature.' }, 401);
  }

  if (!c.env.OPS_HUB) {
    return c.json({ error: 'Realtime Durable Object hub is not bound in this environment.' }, 503);
  }

  const id = c.env.OPS_HUB.idFromName('global-ops-hub');
  const stub = c.env.OPS_HUB.get(id);
  const upgradeUrl = new URL(c.req.url);
  upgradeUrl.searchParams.set('channel', channel);
  return stub.fetch(new Request(upgradeUrl.toString(), c.req.raw));
});
