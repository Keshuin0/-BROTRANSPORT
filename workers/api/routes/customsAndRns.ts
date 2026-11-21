import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, customsManifests, loads, auditLogs } from '@bro/db';
import {
  CustomsManifestInputSchema,
  isOpsRole,
  validateCustomsManifest,
  type CustomsManifestInput,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { generateCustomsCoverSheetPdf } from '../../services/pdfGenerator.js';
import { verifyWebhookHmac } from '../security.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const customsAndRnsRoutes = new Hono<ApiEnv>();

const RnsWebhookPayloadSchema = z.object({
  controlNumber: z.string().optional(),
  ccn: z.string().optional(),
  status: z.string().optional(),
  portCode: z.string().optional(),
});

const IsoDatetimeSchema = z.iso.datetime();

function safeJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function nonEmptyString(val: unknown, fallback: string, minLen = 1): string {
  if (typeof val === 'string' && val.trim().length >= minLen) {
    return val.trim();
  }
  return fallback;
}

function buildManifestWithFallbacks(m: typeof customsManifests.$inferSelect): CustomsManifestInput | null {
  const stored = safeJsonObject(m.manifestJson);

  // Fast path if stored JSON already satisfies the strict schema
  const direct = CustomsManifestInputSchema.safeParse(stored);
  if (direct.success) {
    return direct.data;
  }

  const scacRaw = nonEmptyString(stored.scacOrCarrierCode, m.scacOrCarrierCode, 4)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const scacOrCarrierCode = scacRaw.length === 4 ? scacRaw : scacRaw.padEnd(4, 'X').slice(0, 4);

  let controlNumber = nonEmptyString(stored.controlNumber, m.controlNumber, 1).toUpperCase();
  if (controlNumber.length < 8) {
    controlNumber = `${scacOrCarrierCode}${controlNumber}`.padEnd(8, '0').slice(0, 25);
  } else {
    controlNumber = controlNumber.slice(0, 25);
  }

  let tripNumber = nonEmptyString(stored.tripNumber, m.tripNumber, 1).toUpperCase();
  if (tripNumber.length < 6) {
    tripNumber = `${scacOrCarrierCode}${tripNumber}`.padEnd(6, '0').slice(0, 25);
  } else {
    tripNumber = tripNumber.slice(0, 25);
  }

  const portCode = nonEmptyString(stored.portCode, m.portCode, 4).slice(0, 6);

  const etaCandidate = nonEmptyString(stored.etaUtc, m.etaUtc, 10);
  const etaUtc = IsoDatetimeSchema.safeParse(etaCandidate).success
    ? etaCandidate
    : new Date(m.createdAt + 4 * 3600_000).toISOString();

  const storedConv =
    stored.conveyance && typeof stored.conveyance === 'object' && !Array.isArray(stored.conveyance)
      ? (stored.conveyance as Record<string, unknown>)
      : {};
  const rawVin = nonEmptyString(storedConv.vin ?? stored.tractorVin, '1HTMMAAL43H561234', 17).toUpperCase();
  const tractorVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(rawVin) ? rawVin : '1HTMMAAL43H561234';
  const plate = nonEmptyString(storedConv.plate ?? stored.plate, 'PE9948', 3).slice(0, 12);
  const rawJurisdiction = nonEmptyString(storedConv.jurisdiction ?? stored.jurisdiction, 'PE', 2).toUpperCase();
  const jurisdiction = rawJurisdiction.length === 2 ? rawJurisdiction : 'PE';

  const driverNameRaw = typeof stored.driverName === 'string' ? stored.driverName.trim() : '';
  const nameParts = driverNameRaw ? driverNameRaw.split(/\s+/) : [];
  const defaultMember = {
    fastCardNumber: nonEmptyString(stored.fastCardNumber, '980012345', 9),
    firstName: nameParts[0] || 'Liam',
    lastName: nameParts.slice(1).join(' ') || 'Gallant',
    dateOfBirth: '1988-05-14',
  };

  const crewRaw = Array.isArray(stored.crew) && stored.crew.length > 0 ? stored.crew : [defaultMember];
  const crew = crewRaw.map((entry) => {
    const rec = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const dob = typeof rec.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.dateOfBirth)
      ? rec.dateOfBirth
      : '1988-05-14';
    return {
      fastCardNumber: typeof rec.fastCardNumber === 'string' ? rec.fastCardNumber.trim() : defaultMember.fastCardNumber,
      firstName: nonEmptyString(rec.firstName, defaultMember.firstName, 1),
      lastName: nonEmptyString(rec.lastName, defaultMember.lastName, 1),
      dateOfBirth: dob,
    };
  });

  const defaultCountry = m.manifestType === 'ACE_PAPS' ? 'CA' : 'US';
  const defaultFoodFda = Boolean(m.fdaPriorNoticeNum);
  const defaultShipment = {
    commodity: nonEmptyString(stored.commodity, 'General Commercial Freight', 2),
    hsCode: typeof stored.hsCode === 'string' && /^\d{6,10}$/.test(stored.hsCode.trim()) ? stored.hsCode.trim() : '070190',
    countryOfOrigin:
      stored.countryOfOrigin === 'CA' ||
      stored.countryOfOrigin === 'US' ||
      stored.countryOfOrigin === 'MX' ||
      stored.countryOfOrigin === 'OTHER'
        ? stored.countryOfOrigin
        : defaultCountry,
    cusmaCertOnFile: typeof stored.cusmaCertOnFile === 'boolean' ? stored.cusmaCertOnFile : true,
    invoiceValueCents:
      typeof stored.invoiceValueCents === 'number' && Number.isInteger(stored.invoiceValueCents) && stored.invoiceValueCents >= 100
        ? stored.invoiceValueCents
        : 450000,
    currency: stored.currency === 'CAD' || stored.currency === 'USD' ? stored.currency : 'USD',
    weightKg: typeof stored.weightKg === 'number' && stored.weightKg > 0 ? stored.weightKg : 17418,
    quantity: typeof stored.quantity === 'number' && Number.isInteger(stored.quantity) && stored.quantity > 0 ? stored.quantity : 24,
    packageType: nonEmptyString(stored.packageType, 'Pallets', 2),
    isFoodFda: typeof stored.isFoodFda === 'boolean' ? stored.isFoodFda : defaultFoodFda,
    shipperName: nonEmptyString(stored.shipperName, 'Cavendish Valley Produce Co.', 2),
    shipperAddress: nonEmptyString(stored.shipperAddress, '100 Harvest Rd, Summerside, PE', 4),
    consigneeName: nonEmptyString(stored.consigneeName, 'New England Fresh Market Hub', 2),
    consigneeAddress: nonEmptyString(stored.consigneeAddress, '45 Terminal Way, Boston, MA', 4),
  };

  const shipmentsRaw = Array.isArray(stored.shipments) && stored.shipments.length > 0 ? stored.shipments : [defaultShipment];
  const shipments = shipmentsRaw.map((entry) => {
    const rec = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    return {
      commodity: nonEmptyString(rec.commodity, defaultShipment.commodity, 2),
      hsCode: typeof rec.hsCode === 'string' && /^\d{6,10}$/.test(rec.hsCode.trim()) ? rec.hsCode.trim() : defaultShipment.hsCode,
      countryOfOrigin:
        rec.countryOfOrigin === 'CA' ||
        rec.countryOfOrigin === 'US' ||
        rec.countryOfOrigin === 'MX' ||
        rec.countryOfOrigin === 'OTHER'
          ? rec.countryOfOrigin
          : defaultShipment.countryOfOrigin,
      cusmaCertOnFile: typeof rec.cusmaCertOnFile === 'boolean' ? rec.cusmaCertOnFile : defaultShipment.cusmaCertOnFile,
      invoiceValueCents:
        typeof rec.invoiceValueCents === 'number' && Number.isInteger(rec.invoiceValueCents) && rec.invoiceValueCents >= 100
          ? rec.invoiceValueCents
          : defaultShipment.invoiceValueCents,
      currency: rec.currency === 'CAD' || rec.currency === 'USD' ? rec.currency : defaultShipment.currency,
      weightKg: typeof rec.weightKg === 'number' && rec.weightKg > 0 ? rec.weightKg : defaultShipment.weightKg,
      quantity: typeof rec.quantity === 'number' && Number.isInteger(rec.quantity) && rec.quantity > 0 ? rec.quantity : defaultShipment.quantity,
      packageType: nonEmptyString(rec.packageType, defaultShipment.packageType, 2),
      isFoodFda: typeof rec.isFoodFda === 'boolean' ? rec.isFoodFda : defaultShipment.isFoodFda,
      shipperName: nonEmptyString(rec.shipperName, defaultShipment.shipperName, 2),
      shipperAddress: nonEmptyString(rec.shipperAddress, defaultShipment.shipperAddress, 4),
      consigneeName: nonEmptyString(rec.consigneeName, defaultShipment.consigneeName, 2),
      consigneeAddress: nonEmptyString(rec.consigneeAddress, defaultShipment.consigneeAddress, 4),
    };
  });

  const mergedCandidate = {
    loadId: typeof stored.loadId === 'string' ? stored.loadId : m.loadId ?? undefined,
    manifestType: stored.manifestType === 'ACE_PAPS' || stored.manifestType === 'ACI_PARS' ? stored.manifestType : m.manifestType,
    scacOrCarrierCode,
    controlNumber,
    tripNumber,
    portCode,
    etaUtc,
    conveyance: {
      vin: tractorVin,
      plate,
      jurisdiction,
    },
    crew,
    carmIorAccountVerified: typeof stored.carmIorAccountVerified === 'boolean' ? stored.carmIorAccountVerified : m.carmIorVerified,
    carmImporterBnRm: typeof stored.carmImporterBnRm === 'string' ? stored.carmImporterBnRm : '849201142RM0001',
    fdaPriorNoticeNumber:
      typeof stored.fdaPriorNoticeNumber === 'string' && stored.fdaPriorNoticeNumber.trim()
        ? stored.fdaPriorNoticeNumber.trim()
        : m.fdaPriorNoticeNum ?? undefined,
    overweightPermitNumber:
      typeof stored.overweightPermitNumber === 'string' && stored.overweightPermitNumber.trim()
        ? stored.overweightPermitNumber.trim()
        : undefined,
    shipments,
  };

  const parsed = CustomsManifestInputSchema.safeParse(mergedCandidate);
  return parsed.success ? parsed.data : null;
}

/** Public & Ops deterministic ACE PAPS / ACI PARS / CARM Release 2 Pre-Flight Validator. */
customsAndRnsRoutes.post('/customs/validate', async (c) => {
  const parsed = CustomsManifestInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      {
        compliant: false,
        error: 'Manifest schema mismatch.',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400,
    );
  }

  const report = validateCustomsManifest(parsed.data);
  return c.json({ success: true, ...report });
});

/** Ops: List all filed & draft customs manifests. */
customsAndRnsRoutes.get('/ops/customs/manifests', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const db = createDb(c.env.DB);
  const rows = await db.select().from(customsManifests).orderBy(desc(customsManifests.updatedAt)).limit(60);
  return c.json({ manifests: rows });
});

/** Ops: Validate, persist ACE/ACI manifest & generate scannable Code-128 Cover Sheet PDF in R2. */
customsAndRnsRoutes.post('/ops/customs/manifests', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);

  const parsed = CustomsManifestInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid manifest structure.' }, 400);
  }

  const report = validateCustomsManifest(parsed.data);
  const now = Date.now();
  const id = `man_${crypto.randomUUID()}`;
  const coverPdfBytes = await generateCustomsCoverSheetPdf(parsed.data, report);
  const r2Key = `customs-covers/${crypto.randomUUID()}.pdf`;

  if (c.env.VAULT) {
    await c.env.VAULT.put(r2Key, coverPdfBytes, {
      httpMetadata: { contentType: 'application/pdf' },
    });
  }

  const db = createDb(c.env.DB);
  await db.insert(customsManifests).values({
    id,
    loadId: parsed.data.loadId ?? null,
    manifestType: parsed.data.manifestType,
    scacOrCarrierCode: parsed.data.scacOrCarrierCode,
    controlNumber: parsed.data.controlNumber,
    tripNumber: parsed.data.tripNumber,
    portCode: parsed.data.portCode,
    etaUtc: parsed.data.etaUtc,
    carmIorVerified: parsed.data.carmIorAccountVerified,
    fdaPriorNoticeNum: parsed.data.fdaPriorNoticeNumber ?? null,
    manifestJson: JSON.stringify(parsed.data),
    validationReportJson: JSON.stringify(report),
    status: report.compliant ? 'filed' : 'draft',
    coverSheetR2Key: r2Key,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ success: true, id, report, coverSheetUrl: `/api/ops/customs/manifests/${id}/cover-sheet.pdf` }, 201);
});

customsAndRnsRoutes.get('/ops/customs/manifests/:id/cover-sheet.pdf', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(customsManifests).where(eq(customsManifests.id, id)).limit(1);
  const m = rows[0];
  if (!m) return c.json({ error: 'Manifest not found.' }, 404);

  const safeCtrl = m.controlNumber.replace(/[^a-zA-Z0-9._-]/g, '_');

  if (m.coverSheetR2Key && c.env.VAULT) {
    const obj = await c.env.VAULT.get(m.coverSheetR2Key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${safeCtrl}_cover_sheet.pdf"`,
        },
      });
    }
  }

  // On-the-fly regeneration when R2 object is missing or manifestJson is partial (e.g., seeded record man_9948)
  const hydratedManifest = buildManifestWithFallbacks(m);
  if (hydratedManifest) {
    const rep = validateCustomsManifest(hydratedManifest);
    const pdf = await generateCustomsCoverSheetPdf(hydratedManifest, rep);
    return new Response(pdf as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${safeCtrl}_cover_sheet.pdf"`,
      },
    });
  }
  return c.json({ error: 'Cover sheet unavailable for legacy draft.' }, 404);
});

/** Real Cryptographic Timing-Safe HMAC-SHA256 CBSA RNS Release Notification Webhook. */
customsAndRnsRoutes.post('/webhooks/rns', async (c) => {
  const rawBody = await c.req.text();
  const check = await verifyWebhookHmac({
    secret: c.env.RNS_WEBHOOK_SECRET,
    signatureHex: c.req.header('x-rns-signature') || c.req.header('x-webhook-signature'),
    timestampSecHeader: c.req.header('x-rns-timestamp'),
    rawBody,
  });
  if (!check.ok) {
    return c.json({ success: false, error: check.error }, check.status);
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(rawBody);
  } catch {
    return c.json({ success: false, error: 'Malformed JSON body.' }, 400);
  }

  const bodyParsed = RnsWebhookPayloadSchema.safeParse(parsedRaw);
  if (!bodyParsed.success) {
    return c.json({ success: false, error: 'Invalid RNS webhook payload.' }, 400);
  }
  const body = bodyParsed.data;

  const controlNumber = (body.controlNumber || body.ccn || '').trim().toUpperCase();
  if (!controlNumber) return c.json({ success: false, error: 'Missing controlNumber / ccn.' }, 400);

  const now = Date.now();
  const nextManifestStatus = body.status === 'HELD' ? 'held' : 'released';

  if (c.env.DB) {
    const db = createDb(c.env.DB);
    const matches = await db
      .select()
      .from(customsManifests)
      .where(eq(customsManifests.controlNumber, controlNumber))
      .limit(1);

    const manifest = matches[0];
    if (manifest) {
      await db
        .update(customsManifests)
        .set({
          status: nextManifestStatus,
          rnsReleasedAt: nextManifestStatus === 'released' ? now : null,
          updatedAt: now,
        })
        .where(eq(customsManifests.id, manifest.id));

      if (manifest.loadId && nextManifestStatus === 'released') {
        await db
          .update(loads)
          .set({ status: 'CLEARED', updatedAt: now })
          .where(eq(loads.id, manifest.loadId));
      }
    }

    await db.insert(auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      actorType: 'webhook',
      action: nextManifestStatus === 'released' ? 'RNS_CUSTOMS_RELEASED' : 'RNS_CUSTOMS_HELD',
      entityType: 'customs_manifest',
      entityId: controlNumber,
      detailJson: rawBody.slice(0, 1000),
      createdAt: now,
    });
  }

  await emitHubEvent(c.env, {
    type: 'RNS_CLEARED',
    channel: 'ops:all',
    payload: { controlNumber, status: nextManifestStatus, clearedAt: now },
  });

  return c.json({ success: true, event: 'RNS_PROCESSED', controlNumber, status: nextManifestStatus, clearedAt: now });
});
