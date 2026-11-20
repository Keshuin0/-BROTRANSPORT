import { z } from 'zod';

export const EbolStageSchema = z.enum([
  'SHIPPER_INIT',
  'CARRIER_PICKUP',
  'IN_TRANSIT_CHECKPOINT',
  'CONSIGNEE_POD',
]);

export type EbolStage = z.infer<typeof EbolStageSchema>;

export const EbolSignRequestSchema = z.object({
  loadId: z.string().min(1),
  stage: EbolStageSchema,
  actorRole: z.enum(['shipper', 'driver', 'consignee', 'dispatcher']),
  actorName: z.string().trim().min(2),
  signerPublicKeyJwk: z.record(z.string(), z.unknown()),
  payloadJson: z.string().min(2),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  blockHash: z.string().regex(/^[0-9a-f]{64}$/),
  ecdsaSignatureB64: z.string().min(16),
  gpsLat: z.number().min(-90).max(90),
  gpsLon: z.number().min(-180).max(180),
  signedAt: z.number().int(),
});

export type EbolSignRequest = z.infer<typeof EbolSignRequestSchema>;

export interface EbolBlockRecord extends EbolSignRequest {
  id: string;
  seq: number;
}

/**
 * Deterministic recursive key-sorted JSON serializer for cryptographic signing.
 */
export function canonicalizePayload(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizePayload(item)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    '{' +
    keys
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalizePayload(record[k])}`)
      .join(',') +
    '}'
  );
}

/**
 * Computes the deterministic domain-separated genesis input string for a load's eBOL chain.
 * Never uses Bitcoin's genesis block hash!
 */
export function ebolGenesisSeed(loadId: string): string {
  return `BRO_TRANSPORT_EBOL_GENESIS_V1:${loadId}`;
}
