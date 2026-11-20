import { Hono } from 'hono';
import { desc, eq, lt } from 'drizzle-orm';
import {
  createDb,
  loads,
  loadStops,
  drivers,
  equipment,
  documents,
  invoices,
  escalations,
  dvirInspections,
  telematicsEvents,
  ediMessages,
  auditLogs,
} from '@bro/db';
import {
  CreateLoadSchema,
  LoadStatusSchema,
  canTransitionLoadStatus,
  computeWeibullSurvival,
  generateEdi214,
  isOpsRole,
  type LoadStatus,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { emitHubEvent } from '../../agents/hubEvents.js';
import { verifyWebhookHmac } from '../security.js';

export const opsDispatchRoutes = new Hono<ApiEnv>();

opsDispatchRoutes.get('/ops/overview', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const db = createDb(c.env.DB);
  const now = Date.now();
  const horizon30d = now + 30 * 86_400_000;

  const [allLoads, pendingDocs, pendingInvoices, openEscalations, expiringDrivers, expiringEquip] =
    await Promise.all([
      db.select().from(loads).orderBy(desc(loads.updatedAt)).limit(50),
      db.select().from(documents).where(eq(documents.ocrStatus, 'awaiting_review')).limit(50),
      db.select().from(invoices).where(eq(invoices.status, 'pending_approval')).limit(50),
      db.select().from(escalations).where(eq(escalations.status, 'open')).limit(50),
      db.select().from(drivers).where(lt(drivers.medicalCardExpiry, horizon30d)).limit(25),
      db.select().from(equipment).where(lt(equipment.annualInspectionExpiry, horizon30d)).limit(25),
    ]);

  return c.json({
    counts: {
      activeLoads: allLoads.filter((l) => l.status !== 'PAID').length,
      atBorder: allLoads.filter((l) => l.status === 'AT_BORDER').length,
      pendingOcrDocs: pendingDocs.length,
      pendingBillingApprovals: pendingInvoices.length,
      openEscalations: openEscalations.length,
      expiringCompliance: expiringDrivers.length + expiringEquip.length,
    },
    recentLoads: allLoads.slice(0, 10),
    openEscalations: openEscalations.slice(0, 5),
  });
});

opsDispatchRoutes.get('/ops/loads', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const db = createDb(c.env.DB);
  const [loadRows, driverRows, equipRows] = await Promise.all([
    db.select().from(loads).orderBy(desc(loads.updatedAt)).limit(100),
    db.select().from(drivers).limit(50),
    db.select().from(equipment).limit(50),
  ]);
  return c.json({ loads: loadRows, drivers: driverRows, equipment: equipRows });
});

opsDispatchRoutes.post('/ops/loads', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const parsed = CreateLoadSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid load data.' }, 400);

  const db = createDb(c.env.DB);
  const now = Date.now();
  const loadId = `load_${crypto.randomUUID().slice(0, 8)}`;
  const loadNumber = `BROP-${new Date(now).getUTCFullYear()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  await db.insert(loads).values({
    id: loadId,
    loadNumber,
    shipperOrgId: parsed.data.shipperOrgId,
    equipmentType: parsed.data.equipmentType,
    direction: parsed.data.direction,
    status: 'BOOKED',
    commodity: parsed.data.commodity,
    weightLbs: parsed.data.weightLbs,
    tempSetpointC: parsed.data.tempSetpointC ?? null,
    isFoodFda: parsed.data.isFoodFda,
    rateCustomerCents: parsed.data.rateCustomerCents,
    rateCarrierCents: parsed.data.rateCarrierCents,
    currency: parsed.data.currency,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(loadStops).values(
    parsed.data.stops.map((s) => ({
      id: `stop_${crypto.randomUUID()}`,
      loadId,
      seq: s.seq,
      stopType: s.stopType,
      facilityName: s.facilityName,
      address: s.address,
      lat: s.lat,
      lon: s.lon,
      apptStart: s.apptStart,
      apptEnd: s.apptEnd,
    })),
  );

  await emitHubEvent(c.env, {
    type: 'LOAD_STATUS_CHANGED',
    channel: 'ops:all',
    payload: { loadId, loadNumber, status: 'BOOKED' },
  });

  return c.json({ success: true, loadId, loadNumber }, 201);
});

opsDispatchRoutes.patch('/ops/loads/:id/assign', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const loadId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    assignedDriverId?: string;
    tractorId?: string;
    trailerId?: string;
  };
  const db = createDb(c.env.DB);
  const now = Date.now();

  // Safety check: refuse assigning equipment currently locked OUT OF SERVICE!
  if (body.tractorId) {
    const eqRow = await db.select().from(equipment).where(eq(equipment.id, body.tractorId)).limit(1);
    if (eqRow[0]?.status === 'out_of_service') {
      return c.json({ error: `Safety Lock: Tractor ${eqRow[0].unitNumber} is OUT OF SERVICE pending mechanic clearance.` }, 409);
    }
  }
  if (body.trailerId) {
    const eqRow = await db.select().from(equipment).where(eq(equipment.id, body.trailerId)).limit(1);
    if (eqRow[0]?.status === 'out_of_service') {
      return c.json({ error: `Safety Lock: Trailer ${eqRow[0].unitNumber} is OUT OF SERVICE pending mechanic clearance.` }, 409);
    }
  }

  await db
    .update(loads)
    .set({
      assignedDriverId: body.assignedDriverId ?? null,
      tractorId: body.tractorId ?? null,
      trailerId: body.trailerId ?? null,
      status: 'DISPATCHED',
      updatedAt: now,
    })
    .where(eq(loads.id, loadId));

  await emitHubEvent(c.env, {
    type: 'LOAD_STATUS_CHANGED',
    channel: 'ops:all',
    payload: { loadId, status: 'DISPATCHED', assignedDriverId: body.assignedDriverId },
  });

  return c.json({ success: true, loadId, status: 'DISPATCHED' });
});

opsDispatchRoutes.patch('/ops/loads/:id/status', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const loadId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const nextParsed = LoadStatusSchema.safeParse(body.status);
  if (!nextParsed.success) return c.json({ error: 'Invalid load status.' }, 400);

  const db = createDb(c.env.DB);
  const rows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
  const load = rows[0];
  if (!load) return c.json({ error: 'Load not found.' }, 404);

  if (!canTransitionLoadStatus(load.status as LoadStatus, nextParsed.data)) {
    return c.json({ error: `Illegal state transition from ${load.status} to ${nextParsed.data}.` }, 409);
  }

  const now = Date.now();
  await db.update(loads).set({ status: nextParsed.data, updatedAt: now }).where(eq(loads.id, loadId));

  const x12 = generateEdi214({
    scac: c.env.SCAC_CODE || 'BROP',
    shipmentId: load.loadNumber,
    statusCode: nextParsed.data === 'DELIVERED' ? 'D1' : 'AF',
    city: 'CORRIDOR',
    stateProv: 'PE',
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
    rawX12: x12,
    parsedJson: JSON.stringify({ status: nextParsed.data }),
    status: 'sent',
    createdAt: now,
  });

  await emitHubEvent(c.env, {
    type: 'LOAD_STATUS_CHANGED',
    channel: 'ops:all',
    payload: { loadId, loadNumber: load.loadNumber, status: nextParsed.data },
  });

  return c.json({ success: true, loadId, status: nextParsed.data });
});

opsDispatchRoutes.get('/ops/fleet', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const db = createDb(c.env.DB);
  const [equipList, driverList, dvirs, latestTelematics] = await Promise.all([
    db.select().from(equipment).limit(50),
    db.select().from(drivers).limit(50),
    db.select().from(dvirInspections).orderBy(desc(dvirInspections.signedAt)).limit(30),
    db.select().from(telematicsEvents).orderBy(desc(telematicsEvents.recordedAt)).limit(40),
  ]);

  return c.json({ equipment: equipList, drivers: driverList, dvirs, telematics: latestTelematics });
});

opsDispatchRoutes.post('/ops/fleet/dvir/:id/clear', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'safety_officer' && user.role !== 'super_admin' && user.role !== 'dispatcher')) {
    return c.json({ error: 'Safety Officer or Admin role required to clear Out-Of-Service lock.' }, 403);
  }
  const dvirId = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(dvirInspections).where(eq(dvirInspections.id, dvirId)).limit(1);
  const dvir = rows[0];
  if (!dvir) return c.json({ error: 'DVIR inspection not found.' }, 404);

  const now = Date.now();
  await db
    .update(dvirInspections)
    .set({ mechanicClearedBy: user.id, mechanicClearedAt: now })
    .where(eq(dvirInspections.id, dvirId));

  await db.update(equipment).set({ status: 'active', updatedAt: now }).where(eq(equipment.id, dvir.tractorId));
  if (dvir.trailerId) {
    await db.update(equipment).set({ status: 'active', updatedAt: now }).where(eq(equipment.id, dvir.trailerId));
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'MECHANIC_DVIR_CLEARED',
    entityType: 'dvir',
    entityId: dvirId,
    detailJson: JSON.stringify({ tractorId: dvir.tractorId, trailerId: dvir.trailerId }),
    createdAt: now,
  });

  return c.json({ success: true, dvirId, equipmentStatus: 'active' });
});

/** Real HMAC-verified ELD / Trailer Telematics Ingest with authentic Weibull-Cox RUL scoring. */
opsDispatchRoutes.post('/telematics/webhook', async (c) => {
  const rawBody = await c.req.text();
  const check = await verifyWebhookHmac({
    secret: c.env.TELEMATICS_WEBHOOK_SECRET,
    signatureHex: c.req.header('x-telematics-signature'),
    timestampSecHeader: c.req.header('x-telematics-timestamp'),
    rawBody,
  });
  if (!check.ok) return c.json({ error: check.error }, check.status);

  const payload = JSON.parse(rawBody) as {
    equipmentId: string;
    loadId?: string;
    lat: number;
    lon: number;
    operatingHours?: number;
    reeferTempC?: number;
    setpointC?: number;
    doorClosed?: boolean;
    axleWeightKg?: number;
    tpmsPsi?: number;
    vibrationHz?: number;
  };

  const tempDev =
    payload.reeferTempC !== undefined && payload.setpointC !== undefined
      ? Math.abs(payload.reeferTempC - payload.setpointC)
      : 0;
  const tpmsDev = payload.tpmsPsi !== undefined ? Math.abs(105 - payload.tpmsPsi) : 0;

  const weibull = computeWeibullSurvival({
    operatingHours: payload.operatingHours ?? 2000,
    tempDeviationC: tempDev,
    tpmsDeviationPsi: tpmsDev,
    vibrationHz: payload.vibrationHz ?? 12.2,
  });

  const now = Date.now();
  const db = createDb(c.env.DB);
  await db.insert(telematicsEvents).values({
    id: `tel_${crypto.randomUUID()}`,
    equipmentId: payload.equipmentId,
    loadId: payload.loadId ?? null,
    lat: payload.lat,
    lon: payload.lon,
    reeferTempC: payload.reeferTempC ?? null,
    setpointC: payload.setpointC ?? null,
    doorClosed: payload.doorClosed ?? true,
    axleWeightKg: payload.axleWeightKg ?? null,
    tpmsPsi: payload.tpmsPsi ?? null,
    vibrationHz: payload.vibrationHz ?? null,
    weibullHazard: weibull.instantaneousHazard,
    failureRiskPct: weibull.failureRiskPct,
    rulHours: weibull.remainingUsefulLifeHours,
    recordedAt: now,
  });

  if (weibull.maintenanceUrgent || tempDev > 2.0 || payload.doorClosed === false) {
    await emitHubEvent(c.env, {
      type: 'TELEMATICS_ALERT',
      channel: 'ops:all',
      payload: { equipmentId: payload.equipmentId, loadId: payload.loadId, weibull, tempDev, doorClosed: payload.doorClosed },
    });
  }

  return c.json({ success: true, weibull });
});
