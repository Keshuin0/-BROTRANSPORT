import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { createDb, documents, loads, iftaLogs, auditLogs } from '@bro/db';
import type { DocumentType } from '@bro/contracts';
import type { CloudflareEnv } from '../../src/env.js';
import { extractDocumentWithWorkersAi } from '../services/aiDocumentOcr.js';
import { emitHubEvent } from '../agents/hubEvents.js';

export interface DocWorkflowParams {
  documentId: string;
  loadId?: string | null;
  docType: DocumentType;
}

export interface DocDecisionPayload {
  decision: 'approve' | 'reject';
  reviewerId: string;
  correctedFields?: Record<string, string | number | boolean | null>;
  reviewerNotes?: string;
}

/**
 * Durable Cloudflare Workflow for AI Document Processing with Human-in-the-Loop (HITL).
 * Steps: R2 Read -> Workers AI Vision OCR -> Deterministic Reconcile -> waitForEvent HITL -> Auto-Trigger Billing on POD!
 */
export class DocumentProcessingWorkflow extends WorkflowEntrypoint<CloudflareEnv, DocWorkflowParams> {
  async run(event: WorkflowEvent<DocWorkflowParams>, step: WorkflowStep): Promise<{ status: string; documentId: string }> {
    const { documentId, loadId, docType } = event.payload;

    // Step 1: Extract structured fields from R2 file via Workers AI Vision
    const extracted = await step.do('extract-document-ocr', async () => {
      const db = createDb(this.env.DB);
      const rows = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
      const doc = rows[0];
      if (!doc) throw new Error(`Document ${documentId} not found.`);

      await db
        .update(documents)
        .set({ ocrStatus: 'extracting', updatedAt: Date.now() })
        .where(eq(documents.id, documentId));

      let expectedRateConCents: number | undefined;
      if (loadId) {
        const loadRows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
        expectedRateConCents = loadRows[0]?.rateCustomerCents;
      }

      const r2Obj = await this.env.VAULT.get(doc.r2Key);
      const bytes = r2Obj ? new Uint8Array(await r2Obj.arrayBuffer()) : new Uint8Array(0);

      const ocrResult = await extractDocumentWithWorkersAi({
        env: this.env,
        docType,
        fileBytes: bytes,
        mimeType: doc.mimeType,
        originalFilename: doc.originalFilename,
        expectedRateConCents,
      });

      const nextStatus = ocrResult.needsHumanReview ? 'awaiting_review' : 'verified';
      await db
        .update(documents)
        .set({
          ocrStatus: nextStatus,
          ocrJson: JSON.stringify(ocrResult),
          ocrConfidence: ocrResult.overallConfidence,
          updatedAt: Date.now(),
        })
        .where(eq(documents.id, documentId));

      return ocrResult;
    });

    // Step 2: Notify Ops Tower live via Durable Object WebSocket
    await step.do('notify-ops-hub', async () => {
      await emitHubEvent(this.env, {
        type: 'DOC_OCR_READY',
        channel: 'ops:all',
        payload: {
          documentId,
          loadId,
          docType,
          confidence: extracted.overallConfidence,
          needsHumanReview: extracted.needsHumanReview,
          reviewReasons: extracted.reviewReasons,
        },
      });
    });

    // Step 3: Durable zero-cost HITL approval pause when confidence < 92%, OS&D, or regulatory doc
    let finalDecision: DocDecisionPayload = {
      decision: 'approve',
      reviewerId: 'auto_high_confidence',
    };

    if (extracted.needsHumanReview) {
      const decisionEvent = await step.waitForEvent<DocDecisionPayload>('ops-doc-approval', {
        type: 'doc_decision',
        timeout: '72 hours',
      });
      finalDecision = decisionEvent.payload;
    }

    // Step 4: Persist final verified state, update IFTA on fuel receipt, trigger BillingWorkflow on POD
    await step.do('apply-verified-document', async () => {
      const db = createDb(this.env.DB);
      const now = Date.now();
      const mergedOcr = {
        ...extracted,
        ...(finalDecision.correctedFields || {}),
      };

      const isApproved = finalDecision.decision === 'approve';
      await db
        .update(documents)
        .set({
          ocrStatus: isApproved ? 'verified' : 'rejected',
          ocrJson: JSON.stringify(mergedOcr),
          reviewNotes: finalDecision.reviewerNotes ?? null,
          verifiedBy: finalDecision.reviewerId !== 'auto_high_confidence' ? finalDecision.reviewerId : null,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(eq(documents.id, documentId));

      await db.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        actorUserId: finalDecision.reviewerId !== 'auto_high_confidence' ? finalDecision.reviewerId : null,
        actorType: finalDecision.reviewerId === 'auto_high_confidence' ? 'workflow' : 'user',
        action: isApproved ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
        entityType: 'document',
        entityId: documentId,
        detailJson: JSON.stringify({ docType, loadId, notes: finalDecision.reviewerNotes }),
        createdAt: now,
      });

      if (!isApproved) return;

      // Auto-record verified Fuel Receipt into IFTA quarterly tax ledger
      if (docType === 'FUEL_RECEIPT' && mergedOcr.fuelLiters && mergedOcr.jurisdictionCode) {
        const d = new Date(now);
        const q = `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        const loadRows = loadId ? await db.select().from(loads).where(eq(loads.id, loadId)).limit(1) : [];
        const tractorId = loadRows[0]?.tractorId ?? 'eq_trc_101';
        await db.insert(iftaLogs).values({
          id: `ifta_${crypto.randomUUID()}`,
          loadId: loadId ?? null,
          tractorId,
          quarter: `${d.getUTCFullYear()}-${q}`,
          jurisdictionCode: String(mergedOcr.jurisdictionCode).toUpperCase(),
          distanceKm: 0,
          fuelLiters: Number(mergedOcr.fuelLiters),
          fuelCostCents: Number(mergedOcr.totalAmountCents ?? 0),
          receiptDocId: documentId,
          createdAt: now,
        });
      }

      // Auto-trigger BillingSettlementWorkflow once a signed POD is verified for a delivered load!
      if (docType === 'POD' && loadId && this.env.BILLING_WORKFLOW) {
        await this.env.BILLING_WORKFLOW.create({
          id: `bill-${loadId}-${now}`,
          params: { loadId, triggeredByDocId: documentId },
        });
      }
    });

    return { status: finalDecision.decision, documentId };
  }
}
