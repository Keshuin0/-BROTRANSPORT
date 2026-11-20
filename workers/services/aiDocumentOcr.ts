import {
  OcrExtractedPayloadSchema,
  evaluateDocumentHitlGate,
  type DocumentType,
  type OcrExtractedPayload,
} from '@bro/contracts';
import type { CloudflareEnv } from '../../src/env.js';

/**
 * Extracts structured trucking document fields via Cloudflare Workers AI Vision / Extraction models.
 * Enforces strict Zod v4 validation + deterministic HITL escalation — AI never self-approves risky documents.
 */
export async function extractDocumentWithWorkersAi(params: {
  env: Partial<CloudflareEnv>;
  docType: DocumentType;
  fileBytes: Uint8Array;
  mimeType: string;
  originalFilename: string;
  expectedRateConCents?: number;
  confidenceThreshold?: number;
}): Promise<OcrExtractedPayload> {
  const { env, docType, fileBytes, mimeType, originalFilename } = params;

  // Attempt live Cloudflare Workers AI Vision structured extraction when AI binding is available
  if (env.AI && mimeType.startsWith('image/')) {
    try {
      const prompt = `Extract structured logistics fields from this ${docType} trucking document image. Return ONLY valid JSON with keys: overallConfidence (0-1), bolNumber, papsOrParsNumber, shipperName, consigneeName, commodity, weightLbs (number), pieces (integer), hasSignature (boolean), hasOsdDamageOrShortage (boolean), osdNotes, totalAmountCents (integer cents), currency ("CAD"|"USD"), fuelLiters (number), jurisdictionCode (2-letter state/province), expiryDateIso (YYYY-MM-DD), hsCodes (string array), rawTextSummary.`;

      const aiResponse = (await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        prompt,
        image: Array.from(fileBytes.slice(0, 2_000_000)),
        max_tokens: 700,
      })) as { response?: string };

      const text = aiResponse?.response || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const rawObj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const candidate = {
          docType,
          overallConfidence: Number(rawObj.overallConfidence ?? 0.85),
          fieldConfidences: {},
          bolNumber: typeof rawObj.bolNumber === 'string' ? rawObj.bolNumber : undefined,
          papsOrParsNumber: typeof rawObj.papsOrParsNumber === 'string' ? rawObj.papsOrParsNumber : undefined,
          shipperName: typeof rawObj.shipperName === 'string' ? rawObj.shipperName : undefined,
          consigneeName: typeof rawObj.consigneeName === 'string' ? rawObj.consigneeName : undefined,
          commodity: typeof rawObj.commodity === 'string' ? rawObj.commodity : undefined,
          weightLbs: typeof rawObj.weightLbs === 'number' ? rawObj.weightLbs : undefined,
          pieces: typeof rawObj.pieces === 'number' ? Math.round(rawObj.pieces) : undefined,
          hasSignature: typeof rawObj.hasSignature === 'boolean' ? rawObj.hasSignature : undefined,
          hasOsdDamageOrShortage: Boolean(rawObj.hasOsdDamageOrShortage),
          osdNotes: typeof rawObj.osdNotes === 'string' ? rawObj.osdNotes : undefined,
          totalAmountCents: typeof rawObj.totalAmountCents === 'number' ? Math.round(rawObj.totalAmountCents) : undefined,
          currency: rawObj.currency === 'USD' ? ('USD' as const) : ('CAD' as const),
          fuelLiters: typeof rawObj.fuelLiters === 'number' ? rawObj.fuelLiters : undefined,
          jurisdictionCode: typeof rawObj.jurisdictionCode === 'string' ? rawObj.jurisdictionCode.slice(0, 2).toUpperCase() : undefined,
          expiryDateIso: typeof rawObj.expiryDateIso === 'string' ? rawObj.expiryDateIso : undefined,
          hsCodes: Array.isArray(rawObj.hsCodes) ? rawObj.hsCodes.map(String) : undefined,
          rawTextSummary: typeof rawObj.rawTextSummary === 'string' ? rawObj.rawTextSummary.slice(0, 1800) : undefined,
        };

        const gate = evaluateDocumentHitlGate(candidate, {
          confidenceThreshold: params.confidenceThreshold,
          expectedRateConCents: params.expectedRateConCents,
        });

        const parsed = OcrExtractedPayloadSchema.safeParse({ ...candidate, ...gate });
        if (parsed.success) return parsed.data;
      }
    } catch (err) {
      console.warn('[aiDocumentOcr] Workers AI vision fallback triggered:', err);
    }
  }

  // Deterministic fallback when AI binding is unavailable (local dev / PDF binary):
  // ALWAYS flags `needsHumanReview = true` (confidence 0.72) so un-OCR'd docs never slip past Ops!
  const lowerName = originalFilename.toLowerCase();
  const baseCandidate = {
    docType,
    overallConfidence: 0.72,
    fieldConfidences: { filename_hint: 0.72 },
    bolNumber: docType === 'BOL' || docType === 'POD' ? `BOL-${originalFilename.replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'PENDING'}` : undefined,
    hasSignature: docType === 'POD' ? !lowerName.includes('unsigned') : undefined,
    hasOsdDamageOrShortage: lowerName.includes('damage') || lowerName.includes('osd'),
    osdNotes: lowerName.includes('damage') ? 'Filename/intake flagged potential OS&D damage — manual inspection mandatory.' : undefined,
    currency: 'CAD' as const,
    rawTextSummary: `Ingested ${mimeType} (${fileBytes.byteLength} bytes) from ${originalFilename}. Routed to Ops Side-by-Side Verification Queue.`,
  };

  const gate = evaluateDocumentHitlGate(baseCandidate, {
    confidenceThreshold: params.confidenceThreshold,
    expectedRateConCents: params.expectedRateConCents,
  });

  return OcrExtractedPayloadSchema.parse({
    ...baseCandidate,
    needsHumanReview: true,
    reviewReasons:
      gate.reviewReasons.length > 0
        ? gate.reviewReasons
        : ['Manual visual verification required when AI Vision extraction is offline or PDF binary uploaded.'],
  });
}
