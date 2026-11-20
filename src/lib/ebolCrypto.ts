import {
  canonicalizePayload,
  ebolGenesisSeed,
  type EbolBlockRecord,
  type EbolSignRequest,
  type EbolStage,
} from '@bro/contracts';

const textEncoder = new TextEncoder();

const ECDSA_KEY_GEN_PARAMS: EcKeyGenParams = {
  name: 'ECDSA',
  namedCurve: 'P-256',
};

const ECDSA_SIGN_PARAMS: EcdsaParams = {
  name: 'ECDSA',
  hash: 'SHA-256',
};

export interface ActorKeyPair {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  thumbprint: string;
}

export interface CreateSignedEbolBlockParams {
  loadId: string;
  seq: number;
  stage: EbolStage;
  actorRole: EbolSignRequest['actorRole'];
  actorName: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  prevHash: string;
  payload: unknown;
  gpsLat: number;
  gpsLon: number;
  signedAt?: number;
}

export interface EbolChainVerificationResult {
  valid: boolean;
  verifiedCount: number;
  brokenBlockSeq?: number;
  reason?: string;
}

function getSubtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is unavailable in this runtime.');
  }
  return globalThis.crypto.subtle;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.trim();
  if (clean.length === 0) return null;
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function extractPublicEcP256Jwk(raw: Record<string, unknown> | JsonWebKey): JsonWebKey | null {
  const rec = raw as Record<string, unknown>;
  if (
    rec.kty !== 'EC' ||
    rec.crv !== 'P-256' ||
    typeof rec.x !== 'string' ||
    typeof rec.y !== 'string' ||
    rec.x.length === 0 ||
    rec.y.length === 0
  ) {
    return null;
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: rec.x,
    y: rec.y,
    ext: true,
  };
}

/**
 * Computes lowercase hex SHA-256 digest using universal Web Crypto (`globalThis.crypto.subtle`).
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const subtle = getSubtle();
  const data = typeof input === 'string' ? textEncoder.encode(input) : input;
  const digest = await subtle.digest('SHA-256', data as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Computes an RFC 7638 canonical SHA-256 hex thumbprint for an EC P-256 public JWK.
 */
export async function computeJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonicalJwk = canonicalizePayload({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return sha256Hex(canonicalJwk);
}

/**
 * Generates an ECDSA P-256 key pair for a custody actor (shipper, driver, consignee, dispatcher).
 */
export async function generateActorKeyPair(): Promise<ActorKeyPair> {
  const subtle = getSubtle();
  const keyPair = (await subtle.generateKey(
    ECDSA_KEY_GEN_PARAMS,
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const exportedPublic = (await subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  const publicKeyJwk: JsonWebKey = {
    kty: exportedPublic.kty,
    crv: exportedPublic.crv,
    x: exportedPublic.x,
    y: exportedPublic.y,
    ext: true,
    key_ops: ['verify'],
  };
  const thumbprint = await computeJwkThumbprint(publicKeyJwk);

  return {
    privateKey: keyPair.privateKey,
    publicKeyJwk,
    thumbprint,
  };
}

/**
 * Computes the deterministic domain-separated genesis hash for a load's eBOL chain.
 * Derived from `ebolGenesisSeed(loadId)` — never Bitcoin's genesis hash.
 */
export async function computeGenesisHash(loadId: string): Promise<string> {
  return sha256Hex(ebolGenesisSeed(loadId));
}

/**
 * Computes the canonical block hash linking `prevHash`, `payloadSha256`, `stage`, and `signedAt`.
 */
export async function computeBlockHash(params: {
  prevHash: string;
  payloadSha256: string;
  stage: EbolStage;
  signedAt: number;
}): Promise<string> {
  return sha256Hex(`${params.prevHash}:${params.payloadSha256}:${params.stage}:${params.signedAt}`);
}

/**
 * Canonicalizes payload, hashes payload and block link, signs `blockHash` with ECDSA P-256,
 * and returns a complete `EbolBlockRecord`.
 */
export async function createSignedEbolBlock(
  params: CreateSignedEbolBlockParams,
): Promise<EbolBlockRecord> {
  const subtle = getSubtle();
  const signedAt = Math.trunc(params.signedAt ?? Date.now());
  const sanitizedPub = extractPublicEcP256Jwk(params.publicKeyJwk);
  if (!sanitizedPub) {
    throw new Error('Invalid ECDSA P-256 publicKeyJwk provided.');
  }

  const payloadJson = canonicalizePayload(params.payload);
  const payloadSha256 = await sha256Hex(payloadJson);
  const blockHash = await computeBlockHash({
    prevHash: params.prevHash,
    payloadSha256,
    stage: params.stage,
    signedAt,
  });

  const signatureBuffer = await subtle.sign(
    ECDSA_SIGN_PARAMS,
    params.privateKey,
    textEncoder.encode(blockHash) as BufferSource,
  );
  const ecdsaSignatureB64 = bytesToBase64(new Uint8Array(signatureBuffer));

  const signerPublicKeyJwk: Record<string, unknown> = {
    ...sanitizedPub,
    key_ops: ['verify'],
  };

  return {
    id: globalThis.crypto.randomUUID(),
    loadId: params.loadId,
    seq: params.seq,
    stage: params.stage,
    actorRole: params.actorRole,
    actorName: params.actorName,
    signerPublicKeyJwk,
    payloadJson,
    payloadSha256,
    prevHash: params.prevHash,
    blockHash,
    ecdsaSignatureB64,
    gpsLat: params.gpsLat,
    gpsLon: params.gpsLon,
    signedAt,
  };
}

/**
 * Independently verifies an entire eBOL custody chain from the domain-separated genesis hash:
 * checks load binding, `prevHash` continuity, sequence continuity, `payloadSha256`,
 * `blockHash`, and every ECDSA P-256 signature via `crypto.subtle.verify()`.
 */
export async function verifyEbolChain(
  loadId: string,
  blocks: EbolBlockRecord[],
): Promise<EbolChainVerificationResult> {
  if (blocks.length === 0) {
    return {
      valid: false,
      verifiedCount: 0,
      reason: 'eBOL chain contains no custody blocks.',
    };
  }

  const subtle = getSubtle();
  let expectedPrevHash = await computeGenesisHash(loadId);
  let verifiedCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (block.loadId !== loadId) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Load ID mismatch at seq ${block.seq}: expected '${loadId}', found '${block.loadId}'.`,
      };
    }

    if (!Number.isInteger(block.seq) || block.seq < 0) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Invalid sequence number at index ${i}.`,
      };
    }

    if (block.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Hash chain broken at seq ${block.seq}: prevHash does not match expected predecessor.`,
      };
    }

    if (i > 0 && block.seq !== blocks[i - 1].seq + 1) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Non-contiguous sequence number at seq ${block.seq} (expected ${blocks[i - 1].seq + 1}).`,
      };
    }

    const recomputedPayloadHash = await sha256Hex(block.payloadJson);
    if (recomputedPayloadHash !== block.payloadSha256) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Payload integrity failure at seq ${block.seq}: payloadSha256 mismatch.`,
      };
    }

    const recomputedBlockHash = await computeBlockHash({
      prevHash: block.prevHash,
      payloadSha256: recomputedPayloadHash,
      stage: block.stage,
      signedAt: block.signedAt,
    });
    if (recomputedBlockHash !== block.blockHash) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Block hash integrity failure at seq ${block.seq}: blockHash mismatch.`,
      };
    }

    const publicJwk = extractPublicEcP256Jwk(block.signerPublicKeyJwk);
    if (!publicJwk) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Malformed ECDSA P-256 signerPublicKeyJwk at seq ${block.seq}.`,
      };
    }

    const signatureBytes = base64ToBytes(block.ecdsaSignatureB64);
    if (!signatureBytes || signatureBytes.length === 0) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Malformed Base64 ECDSA signature at seq ${block.seq}.`,
      };
    }

    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await subtle.importKey(
        'jwk',
        publicJwk,
        ECDSA_KEY_GEN_PARAMS,
        true,
        ['verify'],
      );
    } catch {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `Unable to import ECDSA P-256 public key at seq ${block.seq}.`,
      };
    }

    let sigValid = false;
    try {
      sigValid = await subtle.verify(
        ECDSA_SIGN_PARAMS,
        cryptoKey,
        signatureBytes as BufferSource,
        textEncoder.encode(recomputedBlockHash) as BufferSource,
      );
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      return {
        valid: false,
        verifiedCount,
        brokenBlockSeq: block.seq,
        reason: `ECDSA P-256 signature verification failed at seq ${block.seq}.`,
      };
    }

    expectedPrevHash = recomputedBlockHash;
    verifiedCount += 1;
  }

  return {
    valid: true,
    verifiedCount,
  };
}
