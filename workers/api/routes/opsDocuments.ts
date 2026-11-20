import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, documents, auditLogs } from '@bro/db';
import { DocumentReviewDecisionSchema, isOpsRole } from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';

export const opsDocumentRoutes = new Hono<ApiEnv>();

opsDocumentRoutes.use('/ops/documents*', async (c, next) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  await next();
});

opsDocumentRoutes.get('/ops/documents', async (c) => {
  const statusFilter = c.req.query('status');
  const db = createDb(c.env.DB);
  const rows = statusFilter
    ? await db
        .select()
        .from(documents)
        .where(eq(documents.ocrStatus, statusFilter as 'awaiting_review'))
        .orderBy(desc(documents.createdAt))
        .limit(100)
    : await db.select().from(documents).orderBy(desc(documents.createdAt)).limit(100);

  return c.json({ documents: rows });
});

opsDocumentRoutes.get('/ops/documents/:id/file', async (c) => {
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  const doc = rows[0];
  if (!doc) return c.json({ error: 'Document not found.' }, 404);
  if (!c.env.VAULT) return c.json({ error: 'R2 vault not bound.' }, 503);

  const obj = await c.env.VAULT.get(doc.r2Key);
  if (!obj) return c.json({ error: 'Binary missing from R2 vault.' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename="${doc.originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});

opsDocumentRoutes.post('/ops/documents/:id/decision', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const parsed = DocumentReviewDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid decision.' }, 400);

  const db = createDb(c.env.DB);
  const rows = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  const doc = rows[0];
  if (!doc) return c.json({ error: 'Document not found.' }, 404);

  // If paused in Cloudflare Workflow waitForEvent, resume workflow directly!
  if (doc.workflowInstanceId && c.env.DOC_WORKFLOW) {
    try {
      const inst = await c.env.DOC_WORKFLOW.get(doc.workflowInstanceId);
      await inst.sendEvent({
        type: 'doc_decision',
        payload: {
          decision: parsed.data.decision,
          reviewerId: user.id,
          correctedFields: parsed.data.correctedFields,
          reviewerNotes: parsed.data.reviewerNotes,
        },
      });
    } catch {
      // Fallback to direct D1 state update if workflow already completed/expired
    }
  }

  const now = Date.now();
  const existingOcr = doc.ocrJson ? (JSON.parse(doc.ocrJson) as Record<string, unknown>) : {};
  const merged = { ...existingOcr, ...(parsed.data.correctedFields || {}) };
  const nextStatus = parsed.data.decision === 'approve' ? 'verified' : 'rejected';

  await db
    .update(documents)
    .set({
      ocrStatus: nextStatus,
      ocrJson: JSON.stringify(merged),
      reviewNotes: parsed.data.reviewerNotes ?? null,
      verifiedBy: user.id,
      verifiedAt: now,
      updatedAt: now,
    })
    .where(eq(documents.id, id));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: nextStatus === 'verified' ? 'OPS_DOCUMENT_APPROVED' : 'OPS_DOCUMENT_REJECTED',
    entityType: 'document',
    entityId: id,
    detailJson: JSON.stringify({ notes: parsed.data.reviewerNotes }),
    createdAt: now,
  });

  return c.json({ success: true, id, ocrStatus: nextStatus });
});
