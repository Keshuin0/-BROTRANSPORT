import { z } from 'zod';

export const DocumentTypeSchema = z.enum([
  'BOL',
  'POD',
  'RATE_CON',
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'LUMPER_RECEIPT',
  'SCALE_TICKET',
  'FUEL_RECEIPT',
  'CUSTOMS_STAMP',
  'CDL',
  'MEDICAL_CARD',
  'COI',
  'W9_CRA_BN',
  'DVIR_PHOTO',
]);

export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const OcrStatusSchema = z.enum([
  'pending',
  'extracting',
  'awaiting_review',
  'verified',
  'rejected',
]);

export type OcrStatus = z.infer<typeof OcrStatusSchema>;

export const OcrFieldConfidenceSchema = z.record(z.string(), z.number().min(0).max(1));

export const OcrExtractedPayloadSchema = z.object({
  docType: DocumentTypeSchema,
  overallConfidence: z.number().min(0).max(1),
  fieldConfidences: OcrFieldConfidenceSchema.default({}),
  bolNumber: z.string().optional(),
  papsOrParsNumber: z.string().optional(),
  shipperName: z.string().optional(),
  consigneeName: z.string().optional(),
  commodity: z.string().optional(),
  weightLbs: z.number().optional(),
  pieces: z.number().int().optional(),
  hasSignature: z.boolean().optional(),
  hasOsdDamageOrShortage: z.boolean().default(false),
  osdNotes: z.string().optional(),
  totalAmountCents: z.number().int().optional(),
  currency: z.enum(['CAD', 'USD']).optional(),
  fuelLiters: z.number().optional(),
  jurisdictionCode: z.string().max(4).optional(),
  expiryDateIso: z.string().optional(),
  hsCodes: z.array(z.string()).optional(),
  rawTextSummary: z.string().max(2000).optional(),
  needsHumanReview: z.boolean(),
  reviewReasons: z.array(z.string()).default([]),
});

export type OcrExtractedPayload = z.infer<typeof OcrExtractedPayloadSchema>;

export const DocumentReviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  correctedFields: z.record(z.string(), z.unknown()).optional(),
  reviewerNotes: z.string().max(500).optional(),
});

export type DocumentReviewDecision = z.infer<typeof DocumentReviewDecisionSchema>;

export const ALLOWED_DOC_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15 MB

/**
 * Deterministic HITL escalation audit for AI-extracted documents.
 * Guarantees AI never auto-approves damaged PODs, low-confidence scans, or financial mismatches.
 */
export function evaluateDocumentHitlGate(
  extracted: Omit<OcrExtractedPayload, 'needsHumanReview' | 'reviewReasons'>,
  options: {
    confidenceThreshold?: number;
    expectedRateConCents?: number;
  } = {},
): { needsHumanReview: boolean; reviewReasons: string[] } {
  const threshold = options.confidenceThreshold ?? 0.92;
  const reasons: string[] = [];

  if (extracted.overallConfidence < threshold) {
    reasons.push(`OCR confidence ${(extracted.overallConfidence * 100).toFixed(1)}% below ${(threshold * 100).toFixed(0)}% threshold.`);
  }
  if (extracted.hasOsdDamageOrShortage) {
    reasons.push('OS&D damage or shortage notation detected — mandatory dispatcher review.');
  }
  if (extracted.docType === 'POD' && extracted.hasSignature === false) {
    reasons.push('Proof of Delivery missing consignee signature.');
  }
  if (extracted.docType === 'COMMERCIAL_INVOICE' || extracted.docType === 'CUSTOMS_STAMP') {
    reasons.push('Cross-border regulatory document requires customs clerk verification.');
  }
  if (
    extracted.docType === 'RATE_CON' &&
    options.expectedRateConCents !== undefined &&
    extracted.totalAmountCents !== undefined &&
    Math.abs(extracted.totalAmountCents - options.expectedRateConCents) > 1
  ) {
    reasons.push(
      `Rate confirmation mismatch: extracted ${extracted.totalAmountCents}c vs booked ${options.expectedRateConCents}c.`,
    );
  }
  if (extracted.docType === 'LUMPER_RECEIPT' && (extracted.totalAmountCents ?? 0) > 50000) {
    reasons.push('Lumper receipt exceeds $500 threshold — requires billing approval.');
  }

  return {
    needsHumanReview: reasons.length > 0,
    reviewReasons: reasons,
  };
}
