import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { createDb, loads, organizations, invoices, documents, ediMessages, auditLogs } from '@bro/db';
import { calculateInvoiceTotals, generateEdi210, type InvoiceLineItem } from '@bro/contracts';
import type { CloudflareEnv } from '../../src/env.js';
import { generateInvoicePdf, mergeFactoringPacketPdf } from '../services/pdfGenerator.js';
import { sendInvoiceEmail } from '../services/email.js';
import { emitHubEvent } from '../agents/hubEvents.js';

export interface BillingWorkflowParams {
  loadId: string;
  triggeredByDocId?: string;
}

export interface BillingApprovalEvent {
  approved: boolean;
  approverUserId: string;
  adjustedLineItems?: InvoiceLineItem[];
}

/**
 * Durable Cloudflare Workflow automating Freight Invoicing & Factoring Packet Assembly.
 * Deterministic accounting math + mandatory HITL pause whenever detention/accessorial variance exists!
 */
export class BillingSettlementWorkflow extends WorkflowEntrypoint<CloudflareEnv, BillingWorkflowParams> {
  async run(event: WorkflowEvent<BillingWorkflowParams>, step: WorkflowStep): Promise<{ invoiceId: string; status: string }> {
    const { loadId } = event.payload;

    const staged = await step.do('audit-and-stage-invoice', async () => {
      const db = createDb(this.env.DB);
      const loadRows = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
      const load = loadRows[0];
      if (!load) throw new Error(`Load ${loadId} not found.`);

      const orgRows = await db.select().from(organizations).where(eq(organizations.id, load.shipperOrgId)).limit(1);
      const org = orgRows[0];

      const lineItems: InvoiceLineItem[] = [
        {
          code: 'LINEHAUL',
          description: `${load.equipmentType.replace('_', ' ').toUpperCase()} Freight — ${load.commodity} (${load.loadNumber})`,
          quantity: 1,
          unitPriceCents: load.rateCustomerCents,
          amountCents: load.rateCustomerCents,
        },
      ];

      let hasAccessorialVariance = false;
      if (load.detentionMinutes > 0) {
        hasAccessorialVariance = true;
        const detentionCents = Math.round((Math.ceil(load.detentionMinutes / 15) * 8500) / 4);
        lineItems.push({
          code: 'DETENTION',
          description: `Verified Facility Detention (${load.detentionMinutes} billable min @ $85/hr)`,
          quantity: 1,
          unitPriceCents: detentionCents,
          amountCents: detentionCents,
        });
      }

      // Check verified lumper receipts linked to load
      const loadDocs = await db.select().from(documents).where(eq(documents.loadId, loadId));
      for (const doc of loadDocs) {
        if (doc.docType === 'LUMPER_RECEIPT' && doc.ocrStatus === 'verified' && doc.ocrJson) {
          const parsed = JSON.parse(doc.ocrJson) as { totalAmountCents?: number };
          if (parsed.totalAmountCents && parsed.totalAmountCents > 0) {
            hasAccessorialVariance = true;
            lineItems.push({
              code: 'LUMPER',
              description: `Verified Lumper Receipt Passthrough (${doc.originalFilename})`,
              quantity: 1,
              unitPriceCents: parsed.totalAmountCents,
              amountCents: parsed.totalAmountCents,
            });
          }
        }
      }

      const totals = calculateInvoiceTotals({
        lineItems,
        direction: load.direction,
        destinationProvince: 'PE',
      });

      const now = Date.now();
      const invoiceId = `inv_${crypto.randomUUID()}`;
      const invoiceNumber = `INV-${new Date(now).getUTCFullYear()}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
      const dueDays = org?.paymentTermsDays ?? 30;
      const dueDate = now + dueDays * 86_400_000;

      await db.insert(invoices).values({
        id: invoiceId,
        invoiceNumber,
        loadId,
        shipperOrgId: load.shipperOrgId,
        currency: load.currency,
        lineItemsJson: JSON.stringify(lineItems),
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        taxLabel: totals.taxLabel,
        totalCents: totals.totalCents,
        status: hasAccessorialVariance ? 'pending_approval' : 'draft',
        dueDate,
        workflowInstanceId: event.instanceId,
        createdAt: now,
        updatedAt: now,
      });

      return {
        invoiceId,
        invoiceNumber,
        loadNumber: load.loadNumber,
        orgName: org?.name ?? 'Commercial Shipper',
        orgAddress: org?.address ?? 'North America',
        billingEmail: org?.billingEmail ?? null,
        currency: load.currency,
        direction: load.direction,
        lineItems,
        totals,
        dueDate,
        hasAccessorialVariance,
      };
    });

    await step.do('notify-billing-desk', async () => {
      await emitHubEvent(this.env, {
        type: 'INVOICE_READY',
        channel: 'ops:all',
        payload: {
          invoiceId: staged.invoiceId,
          invoiceNumber: staged.invoiceNumber,
          totalCents: staged.totals.totalCents,
          needsApproval: staged.hasAccessorialVariance,
        },
      });
    });

    let approved = true;
    let finalItems = staged.lineItems;

    if (staged.hasAccessorialVariance) {
      const approval = await step.waitForEvent<BillingApprovalEvent>('billing-approval', {
        type: 'billing_approval',
        timeout: '7 days',
      });
      approved = approval.payload.approved;
      if (approval.payload.adjustedLineItems && approval.payload.adjustedLineItems.length > 0) {
        finalItems = approval.payload.adjustedLineItems;
      }
    }

    if (!approved) {
      return { invoiceId: staged.invoiceId, status: 'disputed' };
    }

    await step.do('render-pdfs-and-dispatch', async () => {
      const db = createDb(this.env.DB);
      const now = Date.now();
      const finalTotals = calculateInvoiceTotals({
        lineItems: finalItems,
        direction: staged.direction,
        destinationProvince: 'PE',
      });

      const invoicePdfBytes = await generateInvoicePdf({
        invoiceNumber: staged.invoiceNumber,
        orgName: staged.orgName,
        orgAddress: staged.orgAddress,
        loadNumber: staged.loadNumber,
        currency: staged.currency,
        lineItems: finalItems,
        subtotalCents: finalTotals.subtotalCents,
        taxCents: finalTotals.taxCents,
        taxLabel: finalTotals.taxLabel,
        taxCitation: finalTotals.taxCitation,
        totalCents: finalTotals.totalCents,
        dueDateIso: new Date(staged.dueDate).toISOString().slice(0, 10),
        issuedDateIso: new Date(now).toISOString().slice(0, 10),
      });

      const invoiceR2Key = `invoices/${crypto.randomUUID()}.pdf`;
      const packetR2Key = `factoring-packets/${crypto.randomUUID()}.pdf`;

      const pdfBuffers: Uint8Array[] = [invoicePdfBytes];
      const loadDocs = await db.select().from(documents).where(eq(documents.loadId, loadId));
      for (const doc of loadDocs) {
        if (doc.mimeType === 'application/pdf' && doc.ocrStatus === 'verified' && this.env.VAULT) {
          const obj = await this.env.VAULT.get(doc.r2Key);
          if (obj) pdfBuffers.push(new Uint8Array(await obj.arrayBuffer()));
        }
      }

      const factoringPacketBytes = await mergeFactoringPacketPdf(pdfBuffers);

      if (this.env.VAULT) {
        await this.env.VAULT.put(invoiceR2Key, invoicePdfBytes, {
          httpMetadata: { contentType: 'application/pdf' },
        });
        await this.env.VAULT.put(packetR2Key, factoringPacketBytes, {
          httpMetadata: { contentType: 'application/pdf' },
        });
      }

      await db
        .update(invoices)
        .set({
          lineItemsJson: JSON.stringify(finalItems),
          subtotalCents: finalTotals.subtotalCents,
          taxCents: finalTotals.taxCents,
          totalCents: finalTotals.totalCents,
          status: 'sent',
          invoicePdfR2Key: invoiceR2Key,
          factoringPacketR2Key: packetR2Key,
          updatedAt: now,
        })
        .where(eq(invoices.id, staged.invoiceId));

      await db.update(loads).set({ status: 'INVOICED', updatedAt: now }).where(eq(loads.id, loadId));

      const x12 = generateEdi210({
        scac: this.env.SCAC_CODE || 'BROP',
        invoiceNumber: staged.invoiceNumber,
        shipmentId: staged.loadNumber,
        totalCents: finalTotals.totalCents,
        currency: staged.currency,
        receiverId: staged.orgName.slice(0, 15).toUpperCase(),
        controlNumber: String(now).slice(-9),
        nowMs: now,
      });

      await db.insert(ediMessages).values({
        id: `edi_${crypto.randomUUID()}`,
        loadId,
        transactionSet: '210',
        direction: 'outbound',
        controlNumber: String(now).slice(-9),
        rawX12: x12,
        parsedJson: JSON.stringify({ invoiceNumber: staged.invoiceNumber, totalCents: finalTotals.totalCents }),
        status: 'sent',
        createdAt: now,
      });

      if (staged.billingEmail && this.env.RESEND_API_KEY) {
        await sendInvoiceEmail(this.env, {
          to: staged.billingEmail,
          invoiceNumber: staged.invoiceNumber,
          shipperName: staged.orgName,
          loadReference: staged.loadNumber,
          subtotalCents: finalTotals.subtotalCents,
          taxCents: finalTotals.taxCents,
          totalCents: finalTotals.totalCents,
          currency: staged.currency,
          taxLabel: finalTotals.taxLabel,
          dueDateIso: new Date(staged.dueDate).toISOString().slice(0, 10),
          paymentPortalUrl: `${this.env.PUBLIC_APP_URL || 'https://brotransport.com'}/portal/shipper`,
        });
      }

      await db.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        actorType: 'workflow',
        action: 'INVOICE_AND_FACTORING_PACKET_ISSUED',
        entityType: 'invoice',
        entityId: staged.invoiceId,
        detailJson: JSON.stringify({ invoiceNumber: staged.invoiceNumber, totalCents: finalTotals.totalCents }),
        createdAt: now,
      });
    });

    return { invoiceId: staged.invoiceId, status: 'sent' };
  }
}
