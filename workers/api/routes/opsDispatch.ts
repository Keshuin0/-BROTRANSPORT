import { Hono } from 'hono';
import { desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
  createDb,
  loads,
  loadStops,
  quotes,
  drivers,
  equipment,
  documents,
  invoices,
  escalations,
  dvirInspections,
  telematicsEvents,
  ediMessages,
  loadCheckCalls,
  auditLogs,
} from '@bro/db';
import {
  CreateLoadSchema,
  LoadCheckCallCreateSchema,
  LoadStatusSchema,
  calculateDetentionCents,
  canAccessRoute,
  canTransitionLoadStatus,
  computeWeibullSurvival,
  generateEdi214,
  hasPermission,
  isOpsRole,
  type LoadStatus,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { emitHubEvent } from '../../agents/hubEvents.js';
import { verifyWebhookHmac } from '../security.js';

export const opsDispatchRoutes = new Hono<ApiEnv>();

const AssignLoadSchema = z.object({
  assignedDriverId: z.string().trim().min(1).optional(),
  tractorId: z.string().trim().min(1).optional(),
  trailerId: z.string().trim().min(1).optional(),
});

const UpdateLoadStatusSchema = z.object({
  status: LoadStatusSchema,
});

const TelematicsWebhookSchema = z.object({
  equipmentId: z.string().trim().min(1, { error: 'equipmentId is required.' }),
  loadId: z.string().trim().min(1).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  operatingHours: z.number().nonnegative().optional(),
  reeferTempC: z.number().optional(),
  setpointC: z.number().optional(),
  doorClosed: z.boolean().optional(),
  axleWeightKg: z.number().nonnegative().optional(),
  tpmsPsi: z.number().nonnegative().optional(),
  vibrationHz: z.number().nonnegative().optional(),
});

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
  const parsedBody = AssignLoadSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsedBody.success) {
    return c.json({ error: parsedBody.error.issues[0]?.message || 'Invalid assignment payload.' }, 400);
  }
  const body = parsedBody.data;
  const db = createDb(c.env.DB);
  const existingLoad = await db.select({ id: loads.id }).from(loads).where(eq(loads.id, loadId)).limit(1);
  if (!existingLoad[0]) return c.json({ error: 'Load not found.' }, 404);

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
  const nextParsed = UpdateLoadStatusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!nextParsed.success) return c.json({ error: 'Invalid load status.' }, 400);

  const db = createDb(c.env.DB);
  const rows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
  const load = rows[0];
  if (!load) return c.json({ error: 'Load not found.' }, 404);

  if (!canTransitionLoadStatus(load.status as LoadStatus, nextParsed.data.status)) {
    return c.json({ error: `Illegal state transition from ${load.status} to ${nextParsed.data.status}.` }, 409);
  }

  const now = Date.now();
  await db.update(loads).set({ status: nextParsed.data.status, updatedAt: now }).where(eq(loads.id, loadId));

  const x12 = generateEdi214({
    scac: c.env.SCAC_CODE || 'BROP',
    shipmentId: load.loadNumber,
    statusCode: nextParsed.data.status === 'DELIVERED' ? 'D1' : 'AF',
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
    parsedJson: JSON.stringify({ status: nextParsed.data.status }),
    status: 'sent',
    createdAt: now,
  });

  await emitHubEvent(c.env, {
    type: 'LOAD_STATUS_CHANGED',
    channel: 'ops:all',
    payload: { loadId, loadNumber: load.loadNumber, status: nextParsed.data.status },
  });

  return c.json({ success: true, loadId, status: nextParsed.data.status });
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
  if (!user || !hasPermission(user.role, 'maintenance:workorder')) {
    return c.json({ error: 'Safety Officer, Maintenance Manager, Dispatcher, or Admin role required to clear Out-Of-Service lock.' }, 403);
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

/** Deterministic Driver + Tractor + Trailer Matcher for Dispatcher Productivity. */
opsDispatchRoutes.get('/ops/loads/:id/match-candidates', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const loadId = c.req.param('id');
  const db = createDb(c.env.DB);
  const loadRows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
  const load = loadRows[0];
  if (!load) return c.json({ error: 'Load not found.' }, 404);

  const now = Date.now();
  const [allDrivers, allEquip] = await Promise.all([
    db.select().from(drivers).where(eq(drivers.status, 'active')).limit(50),
    db.select().from(equipment).limit(50),
  ]);

  const isCrossBorder = load.direction === 'ca_to_us' || load.direction === 'us_to_ca';

  const rankedDrivers = allDrivers
    .map((d) => {
      let score = 60;
      const reasons: string[] = [];
      const blockers: string[] = [];

      if (d.equipmentDivision === load.equipmentType) {
        score += 25;
        reasons.push(`Certified ${load.equipmentType.replace('_', ' ')} division`);
      }
      if (isCrossBorder && d.fastCardNumber) {
        score += 15;
        reasons.push(`FAST #${d.fastCardNumber}`);
      } else if (isCrossBorder && !d.fastCardNumber) {
        score -= 10;
        reasons.push('No FAST card on file');
      }
      if (d.medicalCardExpiry && d.medicalCardExpiry < now) {
        score -= 100;
        blockers.push('Medical card expired');
      }
      if (d.licenseExpiry && d.licenseExpiry < now) {
        score -= 100;
        blockers.push('CDL expired');
      }
      return {
        driver: d,
        score: Math.max(0, Math.min(100, score)),
        eligible: blockers.length === 0,
        reasons,
        blockers,
      };
    })
    .sort((a, b) => b.score - a.score);

  const tractors = allEquip
    .filter((e) => e.type === 'tractor')
    .map((e) => ({
      equipment: e,
      eligible: e.status === 'active' && e.annualInspectionExpiry > now,
      reason:
        e.status !== 'active'
          ? `Blocked: ${e.status.toUpperCase()}`
          : e.annualInspectionExpiry <= now
            ? 'Blocked: Annual CVIP expired'
            : `Ready (${e.jurisdiction} · ${e.operatingHours} hrs)`,
    }));

  const trailers = allEquip
    .filter((e) => e.type === load.equipmentType)
    .map((e) => ({
      equipment: e,
      eligible: e.status === 'active' && e.annualInspectionExpiry > now,
      reason:
        e.status !== 'active'
          ? `Blocked: ${e.status.toUpperCase()}`
          : `Ready ${e.type.replace('_', ' ')} (${e.plate})`,
    }));

  return c.json({
    loadId: load.id,
    loadNumber: load.loadNumber,
    equipmentType: load.equipmentType,
    rankedDrivers,
    tractors,
    trailers,
  });
});

/** Dispatch & Night Coordinator Check-Calls + Detention Calculator. */
opsDispatchRoutes.get('/ops/loads/:id/check-calls', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const loadId = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(loadCheckCalls)
    .where(eq(loadCheckCalls.loadId, loadId))
    .orderBy(desc(loadCheckCalls.createdAt))
    .limit(50);
  return c.json({ checkCalls: rows });
});

opsDispatchRoutes.post('/ops/loads/:id/check-calls', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const loadId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = LoadCheckCallCreateSchema.safeParse({ ...body, loadId });
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid check-call payload.' }, 400);
  }

  const db = createDb(c.env.DB);
  const now = Date.now();
  const id = `chk_${crypto.randomUUID()}`;
  const data = parsed.data;

  await db.insert(loadCheckCalls).values({
    id,
    loadId: data.loadId,
    driverId: data.driverId ?? null,
    recordedByUserId: user.id,
    recordedByType: user.role === 'night_coordinator' ? 'night_coordinator' : 'dispatcher',
    statusNote: data.statusNote,
    etaUtc: data.etaUtc ?? null,
    locationText: data.locationText,
    detentionMinutes: data.detentionMinutes,
    createdAt: now,
  });

  if (data.detentionMinutes > 0) {
    await db
      .update(loads)
      .set({ detentionMinutes: data.detentionMinutes, updatedAt: now })
      .where(eq(loads.id, data.loadId));
  }

  const billableDetentionCents = calculateDetentionCents(0, data.detentionMinutes * 60_000).detentionCents;

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'LOAD_CHECK_CALL_LOGGED',
    entityType: 'load',
    entityId: data.loadId,
    detailJson: JSON.stringify({
      checkCallId: id,
      locationText: data.locationText,
      detentionMinutes: data.detentionMinutes,
      billableDetentionCents,
    }),
    createdAt: now,
  });

  return c.json({ success: true, id, billableDetentionCents }, 201);
});

/** Load Planner & Backhaul Yield Desk Endpoints. */
opsDispatchRoutes.get('/ops/planner', async (c) => {
  const user = c.get('user');
  if (!user || !canAccessRoute(user.role, '/ops/planner')) {
    return c.json({ error: 'Load Planner, Dispatcher, Executive, or Super Admin required.' }, 403);
  }

  const db = createDb(c.env.DB);
  const [openQuotes, allLoads, allDrivers, allEquip] = await Promise.all([
    db.select().from(quotes).orderBy(desc(quotes.createdAt)).limit(50),
    db.select().from(loads).orderBy(desc(loads.updatedAt)).limit(100),
    db.select().from(drivers).where(eq(drivers.status, 'active')).limit(50),
    db.select().from(equipment).limit(50),
  ]);

  return c.json({
    quotes: openQuotes,
    loads: allLoads,
    drivers: allDrivers,
    equipment: allEquip,
  });
});

opsDispatchRoutes.post('/ops/planner/promote-quote/:id', async (c) => {
  const user = c.get('user');
  if (!user || !hasPermission(user.role, 'load:plan')) {
    return c.json({ error: 'Load planning permission required.' }, 403);
  }

  const quoteId = c.req.param('id');
  const db = createDb(c.env.DB);
  const qRows = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const q = qRows[0];
  if (!q) return c.json({ error: 'Quote not found.' }, 404);
  if (q.status === 'booked') {
    return c.json({ error: 'Quote is already booked into an active load.' }, 409);
  }

  const now = Date.now();
  const loadId = `ld_${crypto.randomUUID()}`;
  const loadNumber = `BROP-${new Date(now).getUTCFullYear()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const direction =
    q.originCountry === 'CA' && q.destCountry === 'US'
      ? 'ca_to_us'
      : q.originCountry === 'US' && q.destCountry === 'CA'
        ? 'us_to_ca'
        : q.originCountry === 'US'
          ? 'domestic_us'
          : 'domestic_ca';

  await db.insert(loads).values({
    id: loadId,
    loadNumber,
    quoteId: q.id,
    shipperOrgId: q.shipperOrgId ?? 'org_cavendish_produce',
    equipmentType: q.equipmentType,
    direction,
    status: 'BOOKED',
    commodity: q.commodity,
    weightLbs: q.weightLbs,
    loadedMiles: Math.max(50, Math.round(q.distanceKm * 0.621371)),
    tempSetpointC: q.tempSetpointC,
    isFoodFda: q.equipmentType === 'reefer',
    rateCustomerCents: q.totalCents,
    rateCarrierCents: Math.round(q.totalCents * 0.8),
    currency: q.currency,
    detentionMinutes: 0,
    createdAt: now,
    updatedAt: now,
  });

  await db.update(quotes).set({ status: 'booked' }).where(eq(quotes.id, q.id));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'QUOTE_PROMOTED_TO_LOAD',
    entityType: 'load',
    entityId: loadId,
    detailJson: JSON.stringify({ quoteRef: q.quoteRef, loadNumber, totalCents: q.totalCents }),
    createdAt: now,
  });

  return c.json({ success: true, loadId, loadNumber }, 201);
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

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Malformed JSON telematics payload.' }, 400);
  }

  const parsedPayload = TelematicsWebhookSchema.safeParse(rawParsed);
  if (!parsedPayload.success) {
    return c.json({ error: parsedPayload.error.issues[0]?.message || 'Invalid telematics payload.' }, 400);
  }
  const payload = parsedPayload.data;

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
