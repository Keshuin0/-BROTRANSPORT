import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import {
  createDb,
  loads,
  loadStops,
  quotes,
  invoices,
  documents,
  telematicsEvents,
  ebolBlocks,
  organizations,
  users,
  type BroDatabase,
} from '@bro/db';
import { DocumentTypeSchema, ALLOWED_DOC_MIMES, MAX_DOC_BYTES } from '@bro/contracts';
import type { SessionUser } from '../../../src/env.js';
import type { ApiEnv } from './authRoutes.js';
import { bytesToHex } from '../security.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const shipperPortalRoutes = new Hono<ApiEnv>();

function detectMagicMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  // JPEG FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // PNG 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // PDF 25 50 44 46 (%PDF)
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  // WebP RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Idempotently resolves or provisions an isolated shipper organization in D1 for `user`.
 * Never falls back to 'org_cavendish_produce' (prevents cross-tenant data leakage).
 */
async function ensureShipperOrgForUser(db: BroDatabase, user: SessionUser): Promise<string> {
  if (user.organizationId) {
    const existingOrg = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1);
    if (existingOrg[0]) {
      return existingOrg[0].id;
    }
  }

  const userRows = await db
    .select({ id: users.id, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const dbUser = userRows[0];

  if (dbUser?.organizationId) {
    const existingOrg = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, dbUser.organizationId))
      .limit(1);
    if (existingOrg[0]) {
      return existingOrg[0].id;
    }
  }

  const now = Date.now();
  const orgId = `org_${crypto.randomUUID()}`;
  const cleanName = user.name?.trim() || user.email.split('@')[0] || 'Commercial Shipper';

  await db.insert(organizations).values({
    id: orgId,
    name: `${cleanName} Logistics`,
    type: 'shipper',
    carmRppVerified: false,
    currency: 'CAD',
    paymentTermsDays: 30,
    billingEmail: user.email.trim().toLowerCase(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  if (dbUser) {
    await db
      .update(users)
      .set({ organizationId: orgId, updatedAt: now })
      .where(eq(users.id, user.id));
  }

  return orgId;
}

shipperPortalRoutes.use('/shipper/*', async (c, next) => {
  const user = c.get('user');
  if (!user || (!user.role.startsWith('shipper') && user.role !== 'super_admin')) {
    return c.json({ error: 'Shipper portal authentication required.' }, 403);
  }
  await next();
});

shipperPortalRoutes.get('/shipper/dashboard', async (c) => {
  const user = c.get('user')!;
  const db = createDb(c.env.DB);
  const orgId = await ensureShipperOrgForUser(db, user);

  const orgLoads = await db
    .select()
    .from(loads)
    .where(eq(loads.shipperOrgId, orgId))
    .orderBy(desc(loads.updatedAt))
    .limit(30);

  const orgQuotes = await db
    .select()
    .from(quotes)
    .where(eq(quotes.shipperOrgId, orgId))
    .orderBy(desc(quotes.createdAt))
    .limit(20);

  const orgInvoices = await db
    .select()
    .from(invoices)
    .where(eq(invoices.shipperOrgId, orgId))
    .orderBy(desc(invoices.createdAt))
    .limit(30);

  const orgDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.orgId, orgId))
    .orderBy(desc(documents.createdAt))
    .limit(40);

  return c.json({
    organizationId: orgId,
    loads: orgLoads,
    quotes: orgQuotes,
    invoices: orgInvoices,
    documents: orgDocs,
  });
});

shipperPortalRoutes.post('/shipper/quotes/:quoteRef/book', async (c) => {
  const user = c.get('user')!;
  const quoteRef = c.req.param('quoteRef');
  const db = createDb(c.env.DB);
  const orgId = await ensureShipperOrgForUser(db, user);

  const qRows = await db.select().from(quotes).where(eq(quotes.quoteRef, quoteRef)).limit(1);
  const q = qRows[0];
  if (!q) return c.json({ error: 'Quote not found.' }, 404);
  if (q.shipperOrgId && q.shipperOrgId !== orgId && user.role !== 'super_admin') {
    return c.json({ error: 'Forbidden: quote belongs to another organization.' }, 403);
  }

  const now = Date.now();
  const loadId = `load_${crypto.randomUUID().slice(0, 8)}`;
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
    shipperOrgId: orgId,
    equipmentType: q.equipmentType,
    direction,
    status: 'BOOKED',
    commodity: q.commodity,
    weightLbs: q.weightLbs,
    loadedMiles: Math.round(q.distanceKm / 1.60934),
    tempSetpointC: q.tempSetpointC,
    isFoodFda: false,
    rateCustomerCents: q.totalCents,
    rateCarrierCents: Math.round(q.totalCents * 0.72),
    currency: q.currency,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(loadStops).values([
    {
      id: `stop_${crypto.randomUUID()}`,
      loadId,
      seq: 1,
      stopType: 'pickup',
      facilityName: q.originLabel,
      address: q.originLabel,
      lat: q.originLat,
      lon: q.originLon,
      apptStart: now + 24 * 3600_000,
      apptEnd: now + 26 * 3600_000,
    },
    {
      id: `stop_${crypto.randomUUID()}`,
      loadId,
      seq: 2,
      stopType: 'delivery',
      facilityName: q.destLabel,
      address: q.destLabel,
      lat: q.destLat,
      lon: q.destLon,
      apptStart: now + 48 * 3600_000,
      apptEnd: now + 50 * 3600_000,
    },
  ]);

  await db.update(quotes).set({ status: 'booked', shipperOrgId: q.shipperOrgId ?? orgId }).where(eq(quotes.id, q.id));

  return c.json({ success: true, loadId, loadNumber }, 201);
});

shipperPortalRoutes.get('/shipper/loads/:loadId/telemetry', async (c) => {
  const user = c.get('user')!;
  const loadId = c.req.param('loadId');
  const db = createDb(c.env.DB);
  const orgId = await ensureShipperOrgForUser(db, user);

  // Enforce strict tenant isolation!
  const loadRows = await db
    .select()
    .from(loads)
    .where(user.role === 'super_admin' ? eq(loads.id, loadId) : and(eq(loads.id, loadId), eq(loads.shipperOrgId, orgId)))
    .limit(1);

  if (loadRows.length === 0) {
    return c.json({ error: 'Forbidden or load not found.' }, 404);
  }

  const events = await db
    .select()
    .from(telematicsEvents)
    .where(eq(telematicsEvents.loadId, loadId))
    .orderBy(desc(telematicsEvents.recordedAt))
    .limit(200);

  const ebol = await db.select().from(ebolBlocks).where(eq(ebolBlocks.loadId, loadId));

  return c.json({ load: loadRows[0], telemetry: events, ebolBlocksCount: ebol.length });
});

shipperPortalRoutes.post('/shipper/documents/upload', async (c) => {
  const user = c.get('user')!;
  const db = createDb(c.env.DB);
  const orgId = await ensureShipperOrgForUser(db, user);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'Expected multipart/form-data.' }, 400);

  const file = form.get('file');
  const rawDocType = String(form.get('docType') ?? 'COMMERCIAL_INVOICE');
  const loadIdRaw = form.get('loadId');
  const loadId = loadIdRaw ? String(loadIdRaw).trim() || null : null;

  const docTypeParsed = DocumentTypeSchema.safeParse(rawDocType);
  if (!docTypeParsed.success) {
    return c.json({ error: 'Unsupported document type.' }, 400);
  }
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing uploaded file.' }, 400);
  }
  if (file.size === 0 || file.size > MAX_DOC_BYTES) {
    return c.json({ error: 'File must be between 1 byte and 15 MB.' }, 400);
  }

  // Enforce tenant ownership if attaching to a load
  if (loadId) {
    const loadCheck = await db
      .select({ id: loads.id })
      .from(loads)
      .where(
        user.role === 'super_admin'
          ? eq(loads.id, loadId)
          : and(eq(loads.id, loadId), eq(loads.shipperOrgId, orgId)),
      )
      .limit(1);
    if (loadCheck.length === 0) {
      return c.json({ error: 'Forbidden: load not found for your organization.' }, 403);
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedMime = detectMagicMime(bytes);
  if (!detectedMime || !(ALLOWED_DOC_MIMES as readonly string[]).includes(detectedMime)) {
    return c.json({ error: 'Unsupported file content. Allowed: JPEG, PNG, WebP, or PDF.' }, 400);
  }

  const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  const ext = detectedMime === 'application/pdf' ? 'pdf' : detectedMime.split('/')[1] || 'bin';
  const docId = `doc_${crypto.randomUUID()}`;
  const r2Key = `vault/${crypto.randomUUID()}.${ext}`;

  if (c.env.VAULT) {
    await c.env.VAULT.put(r2Key, bytes, {
      httpMetadata: { contentType: detectedMime },
      customMetadata: {
        docId,
        originalFilename: file.name.slice(0, 120),
        uploadedBy: user.id,
        orgId,
        docType: docTypeParsed.data,
      },
    });
  }

  const now = Date.now();
  let workflowInstanceId: string | null = null;

  // Persist document record BEFORE launching DOC_WORKFLOW to prevent workflow race conditions
  await db.insert(documents).values({
    id: docId,
    loadId,
    orgId,
    uploadedByUserId: user.id,
    docType: docTypeParsed.data,
    r2Key,
    originalFilename: file.name.slice(0, 120),
    mimeType: detectedMime,
    sizeBytes: file.size,
    sha256Hex: sha256,
    ocrStatus: 'pending',
    workflowInstanceId: null,
    createdAt: now,
    updatedAt: now,
  });

  if (c.env.DOC_WORKFLOW) {
    try {
      const wf = await c.env.DOC_WORKFLOW.create({
        id: `docwf-${docId}`,
        params: { documentId: docId, loadId, docType: docTypeParsed.data },
      });
      workflowInstanceId = wf.id;
      await db
        .update(documents)
        .set({ workflowInstanceId, ocrStatus: 'extracting', updatedAt: Date.now() })
        .where(eq(documents.id, docId));
    } catch (err) {
      console.warn('[SHIPPER_DOC_WORKFLOW] create skipped:', err);
      await db
        .update(documents)
        .set({ ocrStatus: 'awaiting_review', updatedAt: Date.now() })
        .where(eq(documents.id, docId));
    }
  } else {
    const { extractDocumentWithWorkersAi } = await import('../../services/aiDocumentOcr.js');
    const ocr = await extractDocumentWithWorkersAi({
      env: c.env,
      docType: docTypeParsed.data,
      fileBytes: bytes,
      mimeType: detectedMime,
      originalFilename: file.name,
    });
    await db
      .update(documents)
      .set({
        ocrStatus: ocr.needsHumanReview ? 'awaiting_review' : 'verified',
        ocrJson: JSON.stringify(ocr),
        ocrConfidence: ocr.overallConfidence,
        updatedAt: Date.now(),
      })
      .where(eq(documents.id, docId));
  }

  await emitHubEvent(c.env, {
    type: 'DOC_OCR_READY',
    channel: 'ops:all',
    payload: {
      documentId: docId,
      loadId,
      docType: docTypeParsed.data,
      uploadedBy: user.name,
      source: 'shipper_portal',
    },
  });

  return c.json({ success: true, documentId: docId, sha256, workflowInstanceId }, 201);
});
