export const DEFAULT_POW_DIFFICULTY_BITS = 16;
export const POW_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const POW_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes clock skew
export const POW_REPLAY_TTL_SECONDS = 86_400; // 24 hours

export type PowFailureReason =
  | 'MALFORMED_TOKEN'
  | 'INVALID_PAYLOAD_HASH'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_FUTURE_TIMESTAMP'
  | 'INSUFFICIENT_WORK'
  | 'TOKEN_REPLAYED';

export interface PowVerificationResult {
  valid: boolean;
  reason: 'VERIFIED' | PowFailureReason;
  leadingZeroBits?: number;
  digestHex?: string;
  timestampMs?: number;
}

export interface PowVerifyOptions {
  nowMs?: number;
  difficultyBits?: number;
}

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const TIMESTAMP_REGEX = /^\d{10,16}$/;
const NONCE_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Computes lowercase hexadecimal SHA-256 digest using Web Crypto (`crypto.subtle`).
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digestBuffer));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Counts consecutive leading zero bits in a byte array (MSB-first).
 */
export function countLeadingZeroBits(bytes: Uint8Array): number {
  let zeroBits = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0) {
      zeroBits += 8;
      continue;
    }
    zeroBits += Math.clz32(byte) - 24;
    break;
  }
  return zeroBits;
}

/**
 * Constant-time string comparison for fixed-length hex digests.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies an offline Proof-of-Work token (`timestamp:nonce:payloadHash`):
 * 1. Validates token syntax and constant-time payload hash binding
 * 2. Enforces 24-hour freshness window (and <= 5 min future skew)
 * 3. Verifies SHA-256(token) has >= 16 leading zero bits via `crypto.subtle`
 * 4. Prevents token replay via Cloudflare KV (`pow:used:<digestHex>`, TTL 24h)
 */
export async function verifyOfflinePowToken(
  token: string,
  payloadHashHex: string,
  kv?: KVNamespace,
  options?: PowVerifyOptions,
): Promise<PowVerificationResult> {
  if (typeof token !== 'string' || typeof payloadHashHex !== 'string') {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }

  const trimmedToken = token.trim();
  const expectedHash = payloadHashHex.trim().toLowerCase();

  if (!SHA256_HEX_REGEX.test(expectedHash)) {
    return { valid: false, reason: 'INVALID_PAYLOAD_HASH' };
  }

  const parts = trimmedToken.split(':');
  if (parts.length !== 3) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }

  const [timestampStr, nonce, tokenPayloadHashRaw] = parts;
  if (
    !TIMESTAMP_REGEX.test(timestampStr) ||
    !NONCE_REGEX.test(nonce) ||
    !SHA256_HEX_REGEX.test(tokenPayloadHashRaw)
  ) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }

  const tokenPayloadHash = tokenPayloadHashRaw.toLowerCase();
  if (!timingSafeEqualHex(tokenPayloadHash, expectedHash)) {
    return { valid: false, reason: 'PAYLOAD_HASH_MISMATCH' };
  }

  const timestampMs = Number(timestampStr);
  if (!Number.isSafeInteger(timestampMs)) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const ageMs = nowMs - timestampMs;
  if (ageMs > POW_MAX_AGE_MS) {
    return { valid: false, reason: 'TOKEN_EXPIRED', timestampMs };
  }
  if (ageMs < -POW_MAX_FUTURE_SKEW_MS) {
    return { valid: false, reason: 'TOKEN_FUTURE_TIMESTAMP', timestampMs };
  }

  const requiredBits = options?.difficultyBits ?? DEFAULT_POW_DIFFICULTY_BITS;
  const digestBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(trimmedToken),
  );
  const digestBytes = new Uint8Array(digestBuffer);
  const digestHex = bytesToHex(digestBytes);
  const leadingZeroBits = countLeadingZeroBits(digestBytes);

  if (leadingZeroBits < requiredBits) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_WORK',
      leadingZeroBits,
      digestHex,
      timestampMs,
    };
  }

  if (kv) {
    const replayKey = `pow:used:${digestHex}`;
    const alreadyUsed = await kv.get(replayKey);
    if (alreadyUsed !== null) {
      return {
        valid: false,
        reason: 'TOKEN_REPLAYED',
        leadingZeroBits,
        digestHex,
        timestampMs,
      };
    }

    await kv.put(replayKey, String(nowMs), {
      expirationTtl: POW_REPLAY_TTL_SECONDS,
    });
  }

  return {
    valid: true,
    reason: 'VERIFIED',
    leadingZeroBits,
    digestHex,
    timestampMs,
  };
}
