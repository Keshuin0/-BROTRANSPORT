import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, customsManifests, loads, auditLogs } from '@bro/db';
import { CustomsManifestInputSchema, isOpsRole, validateCustomsManifest } from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { generateCustomsCoverSheetPdf } from '../../services/pdfGenerator.js';
import { verifyWebhookHmac } from '../security.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const customsAndRnsRoutes = new Hono<ApiEnv>();

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

  if (m.coverSheetR2Key && c.env.VAULT) {
    const obj = await c.env.VAULT.get(m.coverSheetR2Key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${m.controlNumber}_cover_sheet.pdf"`,
        },
      });
    }
  }

  // On-the-fly regeneration if seeded record has no R2 object yet
  const parsedManifest = CustomsManifestInputSchema.safeParse(JSON.parse(m.manifestJson));
  if (parsedManifest.success) {
    const rep = validateCustomsManifest(parsedManifest.data);
    const pdf = await generateCustomsCoverSheetPdf(parsedManifest.data, rep);
    return new Response(pdf as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${m.controlNumber}_cover_sheet.pdf"`,
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

  let body: { controlNumber?: string; ccn?: string; status?: string; portCode?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ success: false, error: 'Malformed JSON body.' }, 400);
  }

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
