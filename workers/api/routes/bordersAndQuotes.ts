import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, quotes, drivers, organizations, auditLogs } from '@bro/db';
import {
  CarrierApplicationSchema,
  QuoteEstimateInputSchema,
  QuoteRequestSchema,
  calculateFreightRate,
  isOpsRole,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { getBorderWaitTimes } from '../../services/borderWaitTimes.js';
import { calculateHighwayRoute } from '../../services/routing.js';
import { verifyFmcsaCarrier } from '../../services/fmcsa.js';
import { sendQuoteEmail } from '../../services/email.js';
import { verifyOfflinePowToken, sha256Hex } from '../../services/powVerify.js';
import { checkRateLimit, verifyTurnstileFailClosed } from '../security.js';

export const bordersAndQuotesRoutes = new Hono<ApiEnv>();

/** Live Official CBSA (Canada-bound) & CBP (U.S.-bound) Commercial Border Wait Times. */
bordersAndQuotesRoutes.get('/borders/wait-times', async (c) => {
  const feed = await getBorderWaitTimes(c.env);
  c.header('Cache-Control', 'public, max-age=120');
  return c.json(feed);
});

/** Instant debounced highway-routed freight estimate (no auth required, rate-limited). */
bordersAndQuotesRoutes.post('/quotes/estimate', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const rl = await checkRateLimit(c.env.CACHE, `qest:${ip}`, 90, 60);
  if (!rl.allowed) return c.json({ error: 'Rate limit exceeded.' }, 429);

  const parsed = QuoteEstimateInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid estimate input.' }, 400);
  }

  const input = parsed.data;
  const route = await calculateHighwayRoute(
    input.originLat,
    input.originLon,
    input.destLat,
    input.destLon,
    input.originCountry,
    input.destCountry,
    c.env.CACHE,
  );

  let borderWaitMinutes: number | null = null;
  if (route.recommendedPort) {
    const feed = await getBorderWaitTimes(c.env).catch(() => null);
    const snap = feed?.ports.find((p) => p.cbpCode === route.recommendedPort?.cbpCode);
    if (snap) {
      borderWaitMinutes =
        input.destCountry === 'US' ? snap.southboundCommercialMinutes : snap.northboundCommercialMinutes;
    }
  }

  const estimate = calculateFreightRate(
    input,
    route.distanceKm,
    1.72,
    1.18,
    borderWaitMinutes ?? 15,
  );

  return c.json({
    estimate,
    routingSource: route.source,
    recommendedPort: route.recommendedPort
      ? {
          cbpCode: route.recommendedPort.cbpCode,
          crossingName: route.recommendedPort.crossingName,
          waitMinutes: borderWaitMinutes,
        }
      : null,
  });
});

/** Persist a formal B2B spot/contract rate quote to D1 + send escaped Resend email confirmation. */
bordersAndQuotesRoutes.post('/quotes', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const rl = await checkRateLimit(c.env.CACHE, `qpost:${ip}`, 20, 300);
  if (!rl.allowed) return c.json({ error: 'Too many quote submissions. Try again shortly.' }, 429);

  const parsed = QuoteRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues.map((i) => i.message).join(' '), issues: parsed.error.issues },
      400,
    );
  }

  const user = c.get('user');
  if (!user) {
    if (parsed.data.offlinePowToken) {
      const corePayload = `${parsed.data.contactEmail}:${parsed.data.originCountry}:${parsed.data.destCountry}:${parsed.data.equipmentType}`;
      const payloadHash = await sha256Hex(corePayload);
      const powCheck = await verifyOfflinePowToken(parsed.data.offlinePowToken, payloadHash, c.env.CACHE);
      if (!powCheck.valid) {
        return c.json({ error: `Security proof verification failed: ${powCheck.reason}` }, 403);
      }
    } else if (c.env.TURNSTILE_SECRET_KEY) {
      const check = await verifyTurnstileFailClosed(parsed.data.turnstileToken, c.env, ip);
      if (!check.ok) return c.json({ error: check.error }, 403);
    }
  }

  const input = parsed.data;
  const route = await calculateHighwayRoute(
    input.originLat,
    input.originLon,
    input.destLat,
    input.destLon,
    input.originCountry,
    input.destCountry,
    c.env.CACHE,
  );
  const estimate = calculateFreightRate(input, route.distanceKm);

  const now = Date.now();
  const quoteId = `qt_${crypto.randomUUID()}`;
  const quoteRef = `BROP-QT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const originLabel = `${input.originCity}, ${input.originProvinceState}, ${input.originCountry}`;
  const destLabel = `${input.destCity}, ${input.destProvinceState}, ${input.destCountry}`;

  if (c.env.DB) {
    const db = createDb(c.env.DB);
    await db.insert(quotes).values({
      id: quoteId,
      quoteRef,
      shipperOrgId: user?.organizationId ?? null,
      equipmentType: input.equipmentType,
      originLabel,
      originCountry: input.originCountry,
      originLat: input.originLat,
      originLon: input.originLon,
      destLabel,
      destCountry: input.destCountry,
      destLat: input.destLat,
      destLon: input.destLon,
      distanceKm: estimate.distanceKm,
      weightLbs: input.weightLbs,
      commodity: input.commodity,
      tempSetpointC: input.tempSetpointC ?? null,
      accessorialsJson: JSON.stringify(estimate.accessorialBreakdown),
      linehaulCents: estimate.linehaulCents,
      fscCents: estimate.fuelSurchargeCents,
      customsCents: estimate.customsBrokerageCents,
      accessorialsCents: estimate.accessorialsCents,
      totalCents: estimate.totalCents,
      currency: estimate.currency,
      co2Kg: estimate.co2Kg,
      recommendedPortCode: route.recommendedPort?.cbpCode ?? null,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      status: 'open',
      expiresAt: now + 72 * 3600_000,
      createdAt: now,
    });
  }

  if (c.env.RESEND_API_KEY) {
    await sendQuoteEmail(c.env, {
      to: input.contactEmail,
      quoteReference: quoteRef,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      origin: originLabel,
      destination: destLabel,
      equipmentLabel: estimate.recommendedEquipmentLabel,
      distanceKm: estimate.distanceKm,
      weightLbs: input.weightLbs,
      commodity: input.commodity,
      linehaulCents: estimate.linehaulCents,
      fuelSurchargeCents: estimate.fuelSurchargeCents,
      customsBrokerageCents: estimate.customsBrokerageCents,
      accessorialsCents: estimate.accessorialsCents,
      totalCents: estimate.totalCents,
      currency: estimate.currency,
      estimatedTransitHours: estimate.estimatedTransitHours,
      recommendedPortName: route.recommendedPort?.crossingName ?? null,
    });
  }

  return c.json({ success: true, quoteId, quoteRef, estimate }, 201);
});

/** Live US DOT FMCSA QCMobile Carrier Verification & Double-Brokering Audit. */
bordersAndQuotesRoutes.get('/carriers/verify-dot/:dotNumber', async (c) => {
  const dot = c.req.param('dotNumber').trim();
  if (!/^\d{4,8}$/.test(dot)) {
    return c.json({ error: 'USDOT number must be 4 to 8 numeric digits.' }, 400);
  }
  const result = await verifyFmcsaCarrier(dot, c.env, 0);
  return c.json(result);
});

/** Commercial Driver / Carrier Onboarding (supports online Turnstile OR offline Hashcash PoW). */
bordersAndQuotesRoutes.post('/carriers/apply', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const rawBody = await c.req.text();
  let jsonBody: Record<string, unknown>;
  try {
    jsonBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON payload.' }, 400);
  }

  const parsed = CarrierApplicationSchema.safeParse(jsonBody);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues.map((i) => i.message).join(' '), issues: parsed.error.issues },
      400,
    );
  }

  const data = parsed.data;

  // Dual verification: Offline Hashcash PoW (for border dead-zone queue) OR Cloudflare Turnstile
  if (data.offlinePowToken) {
    const corePayload = `${data.driverEmail}:${data.driverPhone}:${data.equipmentType}`;
    const payloadHash = await sha256Hex(corePayload);
    const powCheck = await verifyOfflinePowToken(data.offlinePowToken, payloadHash, c.env.CACHE);
    if (!powCheck.valid) {
      return c.json({ error: `Offline security proof invalid: ${powCheck.reason}` }, 403);
    }
  } else if (c.env.TURNSTILE_SECRET_KEY) {
    const human = await verifyTurnstileFailClosed(data.turnstileToken, c.env, ip);
    if (!human.ok) return c.json({ error: human.error }, 403);
  }

  // Real FMCSA anti-fraud check when USDOT provided
  let fmcsaReport = null;
  if (data.usdotNumber) {
    fmcsaReport = await verifyFmcsaCarrier(data.usdotNumber, c.env, 0);
    if (fmcsaReport.fraudAssessment && fmcsaReport.fraudAssessment.riskLevel === 'CRITICAL') {
      return c.json(
        {
          error: `FMCSA Safety & Double-Brokering Audit Rejected: ${fmcsaReport.fraudAssessment.findings.map((f) => f.detail).join('; ')}`,
          fmcsaReport,
        },
        403,
      );
    }
  }

  const now = Date.now();
  const intakeId = `BROP-DRV-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const driverId = `drv_${crypto.randomUUID()}`;
  const archiveKey = `applications/${crypto.randomUUID()}.json`;

  if (c.env.VAULT) {
    await c.env.VAULT.put(
      archiveKey,
      JSON.stringify({ intakeId, applicant: data, fmcsaReport, receivedAt: now }),
      { httpMetadata: { contentType: 'application/json' } },
    );
  }

  if (c.env.DB) {
    const db = createDb(c.env.DB);
    let orgId: string | null = null;
    if (data.carrierCompanyName) {
      orgId = `org_${crypto.randomUUID()}`;
      await db.insert(organizations).values({
        id: orgId,
        name: data.carrierCompanyName,
        type: 'carrier',
        usdot: data.usdotNumber ?? null,
        mcNumber: data.mcNumber ?? null,
        phone: data.driverPhone,
        billingEmail: data.driverEmail,
        fmcsaSnapshotJson: fmcsaReport ? JSON.stringify(fmcsaReport) : null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    await db.insert(drivers).values({
      id: driverId,
      organizationId: orgId,
      fullName: data.driverName,
      phone: data.driverPhone,
      email: data.driverEmail,
      equipmentDivision: data.equipmentType,
      preferredLanes: data.preferredLanes,
      status: 'applicant',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      actorType: 'user',
      action: 'CARRIER_APPLICATION_RECEIVED',
      entityType: 'driver',
      entityId: driverId,
      detailJson: JSON.stringify({ intakeId, usdot: data.usdotNumber, archiveKey }),
      createdAt: now,
    });
  }

  return c.json({ success: true, intakeId, driverId, archiveKey, fmcsaReport }, 201);
});

bordersAndQuotesRoutes.get('/ops/carriers', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const db = createDb(c.env.DB);
  const [orgs, drvs] = await Promise.all([
    db.select().from(organizations).orderBy(desc(organizations.createdAt)).limit(50),
    db.select().from(drivers).orderBy(desc(drivers.createdAt)).limit(50),
  ]);
  return c.json({ organizations: orgs, drivers: drvs });
});

bordersAndQuotesRoutes.patch('/ops/carriers/:id/approve', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'safety_officer' && user.role !== 'super_admin')) {
    return c.json({ error: 'Safety Officer or Super Admin required.' }, 403);
  }
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  await db.update(drivers).set({ status: 'active', updatedAt: Date.now() }).where(eq(drivers.id, id));
  return c.json({ success: true, id, status: 'active' });
});
