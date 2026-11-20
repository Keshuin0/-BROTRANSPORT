import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, ediMessages, loads, loadStops, invoices } from '@bro/db';
import {
  generateEdi210,
  generateEdi214,
  generateEdi990,
  generateEdi997,
  isOpsRole,
  parseEdi204,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { emitHubEvent } from '../../agents/hubEvents.js';
import { verifyWebhookHmac } from '../security.js';

export const ediRoutes = new Hono<ApiEnv>();

/** Inbound ANSI X12 204 Motor Carrier Load Tender (Ops or HMAC partner gateway). */
ediRoutes.post('/edi/inbound', async (c) => {
  const user = c.get('user');
  const rawBody = await c.req.text();

  if (!user || !isOpsRole(user.role)) {
    const hmacCheck = await verifyWebhookHmac({
      secret: c.env.EDI_WEBHOOK_SECRET,
      signatureHex: c.req.header('x-edi-signature'),
      timestampSecHeader: c.req.header('x-edi-timestamp'),
      rawBody,
    });
    if (!hmacCheck.ok) return c.json({ error: hmacCheck.error }, hmacCheck.status);
  }

  let parsed204;
  try {
    parsed204 = parseEdi204(rawBody);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'X12 204 parse error' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  const loadId = `load_${crypto.randomUUID().slice(0, 8)}`;
  const loadNumber = parsed204.shipmentId;

  await db.insert(loads).values({
    id: loadId,
    loadNumber,
    shipperOrgId: 'org_cavendish_produce',
    equipmentType: 'dry_van',
    direction: 'ca_to_us',
    status: 'QUOTED',
    commodity: 'EDI 204 Tendered Freight',
    weightLbs: Math.min(45000, parsed204.weightLbs),
    rateCustomerCents: parsed204.rateCents,
    rateCarrierCents: Math.round(parsed204.rateCents * 0.72),
    currency: 'USD',
    createdAt: now,
    updatedAt: now,
  });

  if (parsed204.stops.length > 0) {
    await db.insert(loadStops).values(
      parsed204.stops.map((s) => ({
        id: `stop_${crypto.randomUUID()}`,
        loadId,
        seq: s.seq,
        stopType: (s.reasonCode === 'UL' ? 'delivery' : 'pickup') as 'delivery' | 'pickup',
        facilityName: s.facilityName,
        address: `${s.city}, ${s.stateProv}`,
        lat: 45.0,
        lon: -70.0,
        apptStart: now + 12 * 3600_000,
        apptEnd: now + 14 * 3600_000,
      })),
    );
  }

  const ack997 = generateEdi997({
    scac: c.env.SCAC_CODE || 'BROP',
    receiverId: 'SHIPPER_EDI',
    ackedSet: '204',
    ackedControlNumber: parsed204.controlNumber,
    accepted: true,
    controlNumber: String(now).slice(-9),
    nowMs: now,
  });

  await db.insert(ediMessages).values([
    {
      id: `edi_${crypto.randomUUID()}`,
      loadId,
      transactionSet: '204',
      direction: 'inbound',
      controlNumber: parsed204.controlNumber,
      rawX12: rawBody,
      parsedJson: JSON.stringify(parsed204),
      status: 'processed',
      ack997Received: true,
      createdAt: now,
    },
    {
      id: `edi_${crypto.randomUUID()}`,
      loadId,
      transactionSet: '997',
      direction: 'outbound',
      controlNumber: String(now).slice(-9),
      rawX12: ack997,
      parsedJson: JSON.stringify({ accepted: true }),
      status: 'sent',
      ack997Received: true,
      createdAt: now,
    },
  ]);

  await emitHubEvent(c.env, {
    type: 'EDI_TENDER_RECEIVED',
    channel: 'ops:all',
    payload: { loadId, loadNumber, rateCents: parsed204.rateCents, responseDeadlineMs: now + 15 * 60_000 },
  });

  return c.json({ success: true, loadId, loadNumber, parsed: parsed204, ack997 }, 201);
});

ediRoutes.get('/ops/edi/messages', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const db = createDb(c.env.DB);
  const rows = await db.select().from(ediMessages).orderBy(desc(ediMessages.createdAt)).limit(50);
  return c.json({ messages: rows });
});

ediRoutes.post('/ops/edi/990/:loadId', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const loadId = c.req.param('loadId');
  const body = (await c.req.json().catch(() => ({}))) as { action?: 'A' | 'D' };
  const action = body.action === 'D' ? 'D' : 'A';

  const db = createDb(c.env.DB);
  const rows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
  const load = rows[0];
  if (!load) return c.json({ error: 'Load not found.' }, 404);

  const now = Date.now();
  const rawX12 = generateEdi990({
    scac: c.env.SCAC_CODE || 'BROP',
    shipmentId: load.loadNumber,
    action,
    receiverId: load.shipperOrgId,
    controlNumber: String(now).slice(-9),
    nowMs: now,
  });

  if (action === 'A' && load.status === 'QUOTED') {
    await db.update(loads).set({ status: 'BOOKED', updatedAt: now }).where(eq(loads.id, loadId));
  }

  await db.insert(ediMessages).values({
    id: `edi_${crypto.randomUUID()}`,
    loadId,
    transactionSet: '990',
    direction: 'outbound',
    controlNumber: String(now).slice(-9),
    rawX12,
    parsedJson: JSON.stringify({ action }),
    status: 'sent',
    createdAt: now,
  });

  return c.json({ success: true, transactionSet: '990', action, rawX12 });
});

ediRoutes.post('/ops/edi/210/:invoiceId', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const invoiceId = c.req.param('invoiceId');
  const db = createDb(c.env.DB);
  const invRows = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const inv = invRows[0];
  if (!inv) return c.json({ error: 'Invoice not found.' }, 404);

  const loadRows = await db.select().from(loads).where(eq(loads.id, inv.loadId)).limit(1);
  const now = Date.now();
  const rawX12 = generateEdi210({
    scac: c.env.SCAC_CODE || 'BROP',
    invoiceNumber: inv.invoiceNumber,
    shipmentId: loadRows[0]?.loadNumber || inv.loadId,
    totalCents: inv.totalCents,
    currency: inv.currency,
    receiverId: inv.shipperOrgId,
    controlNumber: String(now).slice(-9),
    nowMs: now,
  });

  await db.insert(ediMessages).values({
    id: `edi_${crypto.randomUUID()}`,
    loadId: inv.loadId,
    transactionSet: '210',
    direction: 'outbound',
    controlNumber: String(now).slice(-9),
    rawX12,
    parsedJson: JSON.stringify({ invoiceNumber: inv.invoiceNumber, totalCents: inv.totalCents }),
    status: 'sent',
    createdAt: now,
  });

  return c.json({ success: true, transactionSet: '210', rawX12 });
});

ediRoutes.post('/ops/edi/214/:loadId', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const loadId = c.req.param('loadId');
  const body = (await c.req.json().catch(() => ({}))) as { statusCode?: 'X3' | 'AF' | 'X1' | 'D1' | 'AG'; city?: string; stateProv?: string };
  const db = createDb(c.env.DB);
  const loadRows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
  const load = loadRows[0];
  if (!load) return c.json({ error: 'Load not found.' }, 404);

  const now = Date.now();
  const rawX12 = generateEdi214({
    scac: c.env.SCAC_CODE || 'BROP',
    shipmentId: load.loadNumber,
    statusCode: body.statusCode || 'AF',
    city: body.city || 'CHARLOTTETOWN',
    stateProv: body.stateProv || 'PE',
    receiverId: load.shipperOrgId,
    controlNumber: String(now).slice(-9),
    nowMs: now,
  });

  await db.insert(ediMessages).values({
    id: `edi_${crypto.randomUUID()}`,
    loadId,
    transactionSet: '214',
    direction: 'outbound',
    controlNumber: String(now).slice(-9),
    rawX12,
    parsedJson: JSON.stringify(body),
    status: 'sent',
    createdAt: now,
  });

  return c.json({ success: true, transactionSet: '214', rawX12 });
});
