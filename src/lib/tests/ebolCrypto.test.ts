import { describe, it, expect } from 'vitest';
import { EbolSignRequestSchema, type EbolBlockRecord } from '@bro/contracts';
import {
  computeGenesisHash,
  createSignedEbolBlock,
  generateActorKeyPair,
  sha256Hex,
  verifyEbolChain,
} from '../ebolCrypto.js';

async function buildThreePartyChain(loadId: string): Promise<{
  blocks: EbolBlockRecord[];
  shipperKey: Awaited<ReturnType<typeof generateActorKeyPair>>;
  driverKey: Awaited<ReturnType<typeof generateActorKeyPair>>;
  consigneeKey: Awaited<ReturnType<typeof generateActorKeyPair>>;
}> {
  const [shipperKey, driverKey, consigneeKey] = await Promise.all([
    generateActorKeyPair(),
    generateActorKeyPair(),
    generateActorKeyPair(),
  ]);

  const genesisHash = await computeGenesisHash(loadId);

  const block1 = await createSignedEbolBlock({
    loadId,
    seq: 1,
    stage: 'SHIPPER_INIT',
    actorRole: 'shipper',
    actorName: 'Cavendish Valley Produce Co.',
    privateKey: shipperKey.privateKey,
    publicKeyJwk: shipperKey.publicKeyJwk,
    prevHash: genesisHash,
    payload: {
      sealNumber: 'SEAL-PE-90412',
      commodity: 'Fresh PEI Potatoes',
      pieces: 24,
      weightLbs: 42500,
      tempSetpointC: 4,
    },
    gpsLat: 46.3959,
    gpsLon: -63.7876,
    signedAt: 1795176000000,
  });

  const block2 = await createSignedEbolBlock({
    loadId,
    seq: 2,
    stage: 'CARRIER_PICKUP',
    actorRole: 'driver',
    actorName: 'Liam Gallant',
    privateKey: driverKey.privateKey,
    publicKeyJwk: driverKey.publicKeyJwk,
    prevHash: block1.blockHash,
    payload: {
      tractorUnit: 'BROP-408',
      trailerUnit: 'RF-5312',
      sealVerified: true,
      reeferTempC: 3.8,
    },
    gpsLat: 46.3961,
    gpsLon: -63.7872,
    signedAt: 1795179600000,
  });

  const block3 = await createSignedEbolBlock({
    loadId,
    seq: 3,
    stage: 'CONSIGNEE_POD',
    actorRole: 'consignee',
    actorName: 'New England Fresh Market Hub',
    privateKey: consigneeKey.privateKey,
    publicKeyJwk: consigneeKey.publicKeyJwk,
    prevHash: block2.blockHash,
    payload: {
      piecesReceived: 24,
      osdExceptions: 'NONE',
      sealIntact: true,
      receiverDock: 'BAY-14',
    },
    gpsLat: 42.3418,
    gpsLon: -71.0365,
    signedAt: 1795222800000,
  });

  return { blocks: [block1, block2, block3], shipperKey, driverKey, consigneeKey };
}

describe('ebolCrypto — Universal Web Crypto ECDSA P-256 Chain of Custody', () => {
  it('computes standard SHA-256 digests and domain-separated genesis hashes (never Bitcoin genesis)', async () => {
    const nistAbc = await sha256Hex('abc');
    expect(nistAbc).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    const bytesHash = await sha256Hex(new TextEncoder().encode('abc'));
    expect(bytesHash).toBe(nistAbc);

    const g1 = await computeGenesisHash('LOAD-2026-1001');
    const g2 = await computeGenesisHash('LOAD-2026-1002');
    expect(g1).toMatch(/^[0-9a-f]{64}$/);
    expect(g1).not.toBe(g2);
    expect(g1).not.toBe('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  });

  it('verifies a complete 3-party custody chain (SHIPPER_INIT -> CARRIER_PICKUP -> CONSIGNEE_POD)', async () => {
    const loadId = 'LOAD-BROP-8843921';
    const { blocks, shipperKey, driverKey, consigneeKey } = await buildThreePartyChain(loadId);

    expect(shipperKey.publicKeyJwk.kty).toBe('EC');
    expect(shipperKey.publicKeyJwk.crv).toBe('P-256');
    expect(shipperKey.thumbprint).toMatch(/^[0-9a-f]{64}$/);
    expect(driverKey.thumbprint).not.toBe(shipperKey.thumbprint);
    expect(consigneeKey.thumbprint).not.toBe(driverKey.thumbprint);

    for (const block of blocks) {
      const parsed = EbolSignRequestSchema.safeParse(block);
      expect(parsed.success).toBe(true);
    }

    const result = await verifyEbolChain(loadId, blocks);
    expect(result).toEqual({ valid: true, verifiedCount: 3 });
  });

  it('detects a 1-byte mutation in payloadJson at the exact brokenBlockSeq', async () => {
    const loadId = 'LOAD-BROP-TAMPER-PAYLOAD';
    const { blocks } = await buildThreePartyChain(loadId);

    // Mutate a single byte in block 2 payloadJson (3.8 -> 3.9)
    const mutatedBlock2: EbolBlockRecord = {
      ...blocks[1],
      payloadJson: blocks[1].payloadJson.replace('3.8', '3.9'),
    };
    expect(mutatedBlock2.payloadJson).not.toBe(blocks[1].payloadJson);

    const res2 = await verifyEbolChain(loadId, [blocks[0], mutatedBlock2, blocks[2]]);
    expect(res2.valid).toBe(false);
    expect(res2.verifiedCount).toBe(1);
    expect(res2.brokenBlockSeq).toBe(2);
    expect(res2.reason).toContain('payloadSha256');

    // Mutate a single byte in block 3 payloadJson (24 -> 23)
    const mutatedBlock3: EbolBlockRecord = {
      ...blocks[2],
      payloadJson: blocks[2].payloadJson.replace('24', '23'),
    };
    const res3 = await verifyEbolChain(loadId, [blocks[0], blocks[1], mutatedBlock3]);
    expect(res3.valid).toBe(false);
    expect(res3.verifiedCount).toBe(2);
    expect(res3.brokenBlockSeq).toBe(3);
  });

  it('rejects forged or mismatched ECDSA P-256 signatures', async () => {
    const loadId = 'LOAD-BROP-FORGED-SIG';
    const { blocks } = await buildThreePartyChain(loadId);

    // Case A: Attacker signs block 3's blockHash with a rogue private key while keeping consignee's publicKeyJwk
    const attackerKey = await generateActorKeyPair();
    const attackerBlock = await createSignedEbolBlock({
      loadId,
      seq: 3,
      stage: 'CONSIGNEE_POD',
      actorRole: 'consignee',
      actorName: 'New England Fresh Market Hub',
      privateKey: attackerKey.privateKey,
      publicKeyJwk: attackerKey.publicKeyJwk,
      prevHash: blocks[1].blockHash,
      payload: JSON.parse(blocks[2].payloadJson),
      gpsLat: blocks[2].gpsLat,
      gpsLon: blocks[2].gpsLon,
      signedAt: blocks[2].signedAt,
    });

    const forgedBlock3: EbolBlockRecord = {
      ...blocks[2],
      ecdsaSignatureB64: attackerBlock.ecdsaSignatureB64,
    };

    const res = await verifyEbolChain(loadId, [blocks[0], blocks[1], forgedBlock3]);
    expect(res.valid).toBe(false);
    expect(res.verifiedCount).toBe(2);
    expect(res.brokenBlockSeq).toBe(3);
    expect(res.reason).toContain('ECDSA');

    // Case B: Flipped signature character in block 1
    const rawSig = blocks[0].ecdsaSignatureB64;
    const flippedChar = rawSig[10] === 'A' ? 'B' : 'A';
    const corruptedBlock1: EbolBlockRecord = {
      ...blocks[0],
      ecdsaSignatureB64: `${rawSig.slice(0, 10)}${flippedChar}${rawSig.slice(11)}`,
    };
    const resCorrupt = await verifyEbolChain(loadId, [corruptedBlock1, blocks[1], blocks[2]]);
    expect(resCorrupt.valid).toBe(false);
    expect(resCorrupt.verifiedCount).toBe(0);
    expect(resCorrupt.brokenBlockSeq).toBe(1);
  });

  it('rejects out-of-order blocks, broken prevHash links, cross-load replays, and empty chains', async () => {
    const loadId = 'LOAD-BROP-ORDER';
    const { blocks } = await buildThreePartyChain(loadId);

    // Out-of-order blocks: [block1, block3, block2]
    const outOfOrder = await verifyEbolChain(loadId, [blocks[0], blocks[2], blocks[1]]);
    expect(outOfOrder.valid).toBe(false);
    expect(outOfOrder.verifiedCount).toBe(1);
    expect(outOfOrder.brokenBlockSeq).toBe(3);
    expect(outOfOrder.reason).toContain('prevHash');

    // Broken prevHash on block 1 (e.g., substituting Bitcoin genesis hash)
    const badGenesisBlock1: EbolBlockRecord = {
      ...blocks[0],
      prevHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    };
    const badGenRes = await verifyEbolChain(loadId, [badGenesisBlock1, blocks[1], blocks[2]]);
    expect(badGenRes.valid).toBe(false);
    expect(badGenRes.brokenBlockSeq).toBe(1);

    // Cross-load replay attempt
    const replayRes = await verifyEbolChain('LOAD-BROP-OTHER', blocks);
    expect(replayRes.valid).toBe(false);
    expect(replayRes.brokenBlockSeq).toBe(1);

    // Empty chain fails closed
    const emptyRes = await verifyEbolChain(loadId, []);
    expect(emptyRes.valid).toBe(false);
    expect(emptyRes.verifiedCount).toBe(0);
  });
});
