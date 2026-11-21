import { Hono } from 'hono';
import { eq, desc, and, isNull } from 'drizzle-orm';
import {
  createDb,
  drivers,
  loads,
  loadStops,
  documents,
  dvirInspections,
  equipment,
  driverSettlements,
  ediMessages,
  auditLogs,
  type BroDatabase,
} from '@bro/db';
import {
  ALLOWED_DOC_MIMES,
  DocumentTypeSchema,
  DvirSubmitSchema,
  MAX_DOC_BYTES,
  StopCheckinSchema,
  calculateDetentionCents,
  generateEdi214,
} from '@bro/contracts';
import type { SessionUser } from '../../../src/env.js';
import type { ApiEnv } from './authRoutes.js';
import { bytesToHex } from '../security.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const driverPortalRoutes = new Hono<ApiEnv>();

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
 * Idempotently resolves or provisions an isolated driver profile bound strictly to `user.id`.
 * Never falls back to another driver's profile (zero cross-tenant leakage).
 */
async function ensureDriverForUser(
  db: BroDatabase,
  user: SessionUser,
): Promise<typeof drivers.$inferSelect> {
  const byUser = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  if (byUser[0]) return byUser[0];

  const emailLower = user.email.trim().toLowerCase();
  const unclaimedByEmail = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.email, emailLower), isNull(drivers.userId)))
    .limit(1);

  if (unclaimedByEmail[0]) {
    const now = Date.now();
    await db
      .update(drivers)
      .set({ userId: user.id, updatedAt: now })
      .where(eq(drivers.id, unclaimedByEmail[0].id));
    return { ...unclaimedByEmail[0], userId: user.id, updatedAt: now };
  }

  const now = Date.now();
  const newDriver: typeof drivers.$inferInsert = {
    id: `drv_${crypto.randomUUID()}`,
    userId: user.id,
    organizationId: user.organizationId ?? null,
    fullName: user.name?.trim() || emailLower,
    phone: '000-000-0000',
    email: emailLower,
    equipmentDivision: 'dry_van',
    preferredLanes: 'Pending Onboarding',
    licenseNumber: null,
    licenseClass: 'Class 1 / AZ',
    licenseExpiry: null,
    medicalCardExpiry: null,
    fastCardNumber: null,
    payModel: 'cpm',
    payRateValue: 68,
    status: 'applicant',
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(drivers).values(newDriver);
  const created = await db.select().from(drivers).where(eq(drivers.id, newDriver.id)).limit(1);
  return created[0]!;
}

driverPortalRoutes.use('/driver/*', async (c, next) => {
  const user = c.get('user');
  if (!user || (user.role !== 'carrier_driver' && user.role !== 'super_admin')) {
    return c.json({ error: 'Driver authentication required.' }, 403);
  }
  await next();
});

driverPortalRoutes.get('/driver/dashboard', async (c) => {
  const user = c.get('user')!;
  const db = createDb(c.env.DB);

  const driver = await ensureDriverForUser(db, user);

  const assignedLoads = await db
    .select()
    .from(loads)
    .where(eq(loads.assignedDriverId, driver.id))
    .orderBy(desc(loads.updatedAt))
    .limit(20);

  const stopsByLoad: Record<string, typeof loadStops.$inferSelect[]> = {};
  for (const l of assignedLoads) {
    stopsByLoad[l.id] = await db.select().from(loadStops).where(eq(loadStops.loadId, l.id));
  }

  const recentDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.driverId, driver.id))
    .orderBy(desc(documents.createdAt))
    .limit(25);

  const settlements = await db
    .select()
    .from(driverSettlements)
    .where(eq(driverSettlements.driverId, driver.id))
    .orderBy(desc(driverSettlements.createdAt))
    .limit(12);

  const fleetUnits = await db.select().from(equipment).limit(25);

  return c.json({ driver, assignedLoads, stopsByLoad, recentDocs, settlements, fleetUnits });
});

driverPortalRoutes.post('/driver/loads/:loadId/stops/:stopId/checkin', async (c) => {
  const user = c.get('user')!;
  const parsed = StopCheckinSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid check-in.' }, 400);

  const { loadId, stopId } = c.req.param();
  const db = createDb(c.env.DB);
  const driver = await ensureDriverForUser(db, user);
  const now = parsed.data.timestampMs ?? Date.now();

  const stopRows = await db
    .select()
    .from(loadStops)
    .where(and(eq(loadStops.id, stopId), eq(loadStops.loadId, loadId)))
    .limit(1);
  const stop = stopRows[0];
  if (!stop) return c.json({ error: 'Load stop not found.' }, 404);

  const loadRows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
  const load = loadRows[0];
  if (!load) return c.json({ error: 'Load not found.' }, 404);

  if (user.role !== 'super_admin' && load.assignedDriverId !== driver.id) {
    return c.json({ error: 'Forbidden: load is not assigned to your driver profile.' }, 403);
  }

  let detentionMinutes = load.detentionMinutes;
  if (parsed.data.event === 'arrived') {
    await db.update(loadStops).set({ arrivedAt: now }).where(eq(loadStops.id, stopId));
  } else {
    await db.update(loadStops).set({ departedAt: now }).where(eq(loadStops.id, stopId));
    if (stop.arrivedAt) {
      const det = calculateDetentionCents(stop.arrivedAt, now);
      detentionMinutes += det.billableMinutes;
    }
  }

  const nextStatus =
    stop.stopType === 'pickup' && parsed.data.event === 'arrived'
      ? 'AT_PICKUP'
      : stop.stopType === 'pickup' && parsed.data.event === 'departed'
        ? 'IN_TRANSIT'
        : stop.stopType === 'border_crossing' && parsed.data.event === 'arrived'
          ? 'AT_BORDER'
          : stop.stopType === 'delivery' && parsed.data.event === 'arrived'
            ? 'AT_DELIVERY'
            : stop.stopType === 'delivery' && parsed.data.event === 'departed'
              ? 'DELIVERED'
              : load.status;

  await db
    .update(loads)
    .set({ status: nextStatus, detentionMinutes, updatedAt: now })
    .where(eq(loads.id, loadId));

  // Automatically emit ANSI X12 EDI 214 status update!
  const ediCode =
    nextStatus === 'AT_PICKUP' ? 'X3' : nextStatus === 'IN_TRANSIT' ? 'AF' : nextStatus === 'AT_DELIVERY' ? 'X1' : 'D1';
  const x12 = generateEdi214({
    scac: c.env.SCAC_CODE || 'BROP',
    shipmentId: load.loadNumber,
    statusCode: ediCode,
    city: stop.facilityName.slice(0, 18),
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
    parsedJson: JSON.stringify({ statusCode: ediCode, nextStatus }),
    status: 'sent',
    createdAt: now,
  });

  await emitHubEvent(c.env, {
    type: 'LOAD_STATUS_CHANGED',
    channel: 'ops:all',
    payload: { loadId, loadNumber: load.loadNumber, status: nextStatus, detentionMinutes },
  });

  return c.json({ success: true, loadStatus: nextStatus, detentionMinutes, edi214Issued: true });
});

driverPortalRoutes.post('/driver/documents/upload', async (c) => {
  const user = c.get('user')!;
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ error: 'Multipart form data required.' }, 400);

  const file = formData.get('file');
  const docTypeRaw = String(formData.get('docType') || 'BOL');
  const loadIdRaw = formData.get('loadId');
  const loadId = loadIdRaw ? String(loadIdRaw).trim() || null : null;

  const docTypeParsed = DocumentTypeSchema.safeParse(docTypeRaw);
  if (!docTypeParsed.success) return c.json({ error: 'Invalid document type.' }, 400);
  if (!(file instanceof File)) return c.json({ error: 'File upload missing.' }, 400);
  if (file.size === 0 || file.size > MAX_DOC_BYTES) {
    return c.json({ error: `File must be between 1 byte and ${MAX_DOC_BYTES / (1024 * 1024)} MB.` }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedMime = detectMagicMime(bytes);
  if (!detectedMime || !(ALLOWED_DOC_MIMES as readonly string[]).includes(detectedMime)) {
    return c.json({ error: 'Unsupported file content. Allowed: JPEG, PNG, WebP, or PDF.' }, 400);
  }

  const db = createDb(c.env.DB);
  const driver = await ensureDriverForUser(db, user);

  if (loadId) {
    const loadCheck = await db
      .select({ id: loads.id, assignedDriverId: loads.assignedDriverId })
      .from(loads)
      .where(eq(loads.id, loadId))
      .limit(1);
    if (!loadCheck[0]) {
      return c.json({ error: 'Referenced load not found.' }, 404);
    }
    if (user.role !== 'super_admin' && loadCheck[0].assignedDriverId !== driver.id) {
      return c.json({ error: 'Forbidden: load is not assigned to your driver profile.' }, 403);
    }
  }

  const sha256Buf = await crypto.subtle.digest('SHA-256', bytes);
  const sha256Hex = bytesToHex(new Uint8Array(sha256Buf));
  const ext = detectedMime === 'application/pdf' ? 'pdf' : detectedMime.split('/')[1];
  const docId = `doc_${crypto.randomUUID()}`;
  // UUID-only R2 object key — zero path traversal / injection risk!
  const r2Key = `documents/${docTypeParsed.data.toLowerCase()}/${crypto.randomUUID()}.${ext}`;

  if (c.env.VAULT) {
    await c.env.VAULT.put(r2Key, bytes, {
      httpMetadata: { contentType: detectedMime },
      customMetadata: { docId, docType: docTypeParsed.data, sha256Hex },
    });
  }

  const now = Date.now();
  let workflowInstanceId: string | null = null;
  await db.insert(documents).values({
    id: docId,
    loadId,
    driverId: driver.id,
    orgId: user.organizationId,
    uploadedByUserId: user.id,
    docType: docTypeParsed.data,
    r2Key,
    originalFilename: file.name.slice(0, 120),
    mimeType: detectedMime,
    sizeBytes: file.size,
    sha256Hex,
    ocrStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  if (c.env.DOC_WORKFLOW) {
    try {
      const inst = await c.env.DOC_WORKFLOW.create({
        id: `docwf-${docId}`,
        params: { documentId: docId, loadId, docType: docTypeParsed.data },
      });
      workflowInstanceId = inst.id;
      await db.update(documents).set({ workflowInstanceId, ocrStatus: 'extracting', updatedAt: Date.now() }).where(eq(documents.id, docId));
    } catch (err) {
      console.warn('[DRIVER_DOC_WORKFLOW] create skipped:', err);
      await db.update(documents).set({ ocrStatus: 'awaiting_review', updatedAt: Date.now() }).where(eq(documents.id, docId));
    }
  } else {
    // Immediate inline extraction when Workflow binding isn't active in local dev
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
    payload: { documentId: docId, docType: docTypeParsed.data, loadId },
  });

  return c.json({ success: true, documentId: docId, sha256Hex, workflowInstanceId }, 201);
});

driverPortalRoutes.post('/driver/dvir', async (c) => {
  const user = c.get('user')!;
  const parsed = DvirSubmitSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid DVIR submission.' }, 400);

  const db = createDb(c.env.DB);
  const driver = await ensureDriverForUser(db, user);
  const driverId = driver.id;

  const tractorCheck = await db.select({ id: equipment.id }).from(equipment).where(eq(equipment.id, parsed.data.tractorId)).limit(1);
  if (!tractorCheck[0]) {
    return c.json({ error: 'Selected tractor equipment unit does not exist.' }, 400);
  }
  if (parsed.data.trailerId) {
    const trailerCheck = await db.select({ id: equipment.id }).from(equipment).where(eq(equipment.id, parsed.data.trailerId)).limit(1);
    if (!trailerCheck[0]) {
      return c.json({ error: 'Selected trailer equipment unit does not exist.' }, 400);
    }
  }

  const defectsFound = parsed.data.checklist.some((item) => item.status === 'defect');
  const now = Date.now();
  const dvirId = `dvir_${crypto.randomUUID()}`;

  await db.insert(dvirInspections).values({
    id: dvirId,
    driverId,
    tractorId: parsed.data.tractorId,
    trailerId: parsed.data.trailerId ?? null,
    inspectionType: parsed.data.inspectionType,
    odometerKm: parsed.data.odometerKm,
    checklistJson: JSON.stringify(parsed.data.checklist),
    defectsFound,
    safeToOperate: parsed.data.safeToOperate,
    driverSignatureName: parsed.data.driverSignatureName,
    signedAt: now,
  });

  // Safety Lock: Critical defect immediately marks equipment OUT OF SERVICE until mechanic sign-off!
  if (!parsed.data.safeToOperate) {
    await db
      .update(equipment)
      .set({ status: 'out_of_service', updatedAt: now })
      .where(eq(equipment.id, parsed.data.tractorId));

    if (parsed.data.trailerId) {
      await db
        .update(equipment)
        .set({ status: 'out_of_service', updatedAt: now })
        .where(eq(equipment.id, parsed.data.trailerId));
    }

    await emitHubEvent(c.env, {
      type: 'TELEMATICS_ALERT',
      channel: 'ops:all',
      payload: {
        dvirId,
        tractorId: parsed.data.tractorId,
        severity: 'CRITICAL',
        message: `Equipment ${parsed.data.tractorId} locked OUT OF SERVICE by driver DVIR.`,
      },
    });
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: parsed.data.safeToOperate ? 'DVIR_PASSED' : 'DVIR_OUT_OF_SERVICE_LOCK',
    entityType: 'dvir',
    entityId: dvirId,
    detailJson: JSON.stringify({ tractorId: parsed.data.tractorId, defectsFound }),
    createdAt: now,
  });

  return c.json({
    success: true,
    dvirId,
    defectsFound,
    equipmentLockedOutOfService: !parsed.data.safeToOperate,
  }, 201);
});
