import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { createDb, ebolBlocks, auditLogs } from '@bro/db';
import { EbolSignRequestSchema, type EbolBlockRecord } from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { verifyEbolChain } from '../../../src/lib/ebolCrypto.js';
import { generateEbolCertificatePdf } from '../../services/pdfGenerator.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const ebolRoutes = new Hono<ApiEnv>();

function rowToBlockRecord(row: typeof ebolBlocks.$inferSelect): EbolBlockRecord {
  return {
    id: row.id,
    seq: row.seq,
    loadId: row.loadId,
    stage: row.stage,
    actorRole: row.actorRole as EbolBlockRecord['actorRole'],
    actorName: row.actorName,
    signerPublicKeyJwk: JSON.parse(row.signerPublicKeyJwk) as Record<string, unknown>,
    payloadJson: row.payloadJson,
    payloadSha256: row.payloadSha256,
    prevHash: row.prevHash,
    blockHash: row.blockHash,
    ecdsaSignatureB64: row.ecdsaSignatureB64,
    gpsLat: row.gpsLat,
    gpsLon: row.gpsLon,
    signedAt: row.signedAt,
  };
}

/** Public verifiable eBOL chain read endpoint for `/verify/[ebolId]`. */
ebolRoutes.get('/ebol/:loadId', async (c) => {
  const loadId = c.req.param('loadId');
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(ebolBlocks)
    .where(eq(ebolBlocks.loadId, loadId))
    .orderBy(asc(ebolBlocks.seq));

  const blocks = rows.map(rowToBlockRecord);
  const verification = blocks.length > 0 ? await verifyEbolChain(loadId, blocks) : { valid: true, verifiedCount: 0 };

  return c.json({ loadId, blocks, verification });
});

/** Append a cryptographically signed ECDSA P-256 block after server-side verification! */
ebolRoutes.post('/ebol/:loadId/sign', async (c) => {
  const loadId = c.req.param('loadId');
  const parsed = EbolSignRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid cryptographic block payload.' }, 400);
  }
  if (parsed.data.loadId !== loadId) {
    return c.json({ error: 'Payload loadId does not match route parameter.' }, 400);
  }

  const db = createDb(c.env.DB);
  const existingRows = await db
    .select()
    .from(ebolBlocks)
    .where(eq(ebolBlocks.loadId, loadId))
    .orderBy(asc(ebolBlocks.seq));

  const existingBlocks = existingRows.map(rowToBlockRecord);
  const nextSeq = existingBlocks.length + 1;
  const candidate: EbolBlockRecord = {
    id: `ebol_${crypto.randomUUID()}`,
    seq: nextSeq,
    ...parsed.data,
  };

  // Cryptographically verify ENTIRE chain INCLUDING the new block BEFORE persisting!
  const check = await verifyEbolChain(loadId, [...existingBlocks, candidate]);
  if (!check.valid) {
    return c.json(
      {
        success: false,
        error: `Cryptographic eBOL signature or hash-chain verification rejected: ${check.reason}`,
        brokenBlockSeq: check.brokenBlockSeq,
      },
      400,
    );
  }

  await db.insert(ebolBlocks).values({
    id: candidate.id,
    loadId,
    seq: candidate.seq,
    stage: candidate.stage,
    actorRole: candidate.actorRole,
    actorName: candidate.actorName,
    signerPublicKeyJwk: JSON.stringify(candidate.signerPublicKeyJwk),
    payloadJson: candidate.payloadJson,
    payloadSha256: candidate.payloadSha256,
    prevHash: candidate.prevHash,
    blockHash: candidate.blockHash,
    ecdsaSignatureB64: candidate.ecdsaSignatureB64,
    gpsLat: candidate.gpsLat,
    gpsLon: candidate.gpsLon,
    signedAt: candidate.signedAt,
  });

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: c.get('user')?.id ?? null,
    actorType: 'user',
    action: 'EBOL_BLOCK_SIGNED',
    entityType: 'ebol',
    entityId: loadId,
    detailJson: JSON.stringify({ seq: candidate.seq, stage: candidate.stage, blockHash: candidate.blockHash }),
    createdAt: Date.now(),
  });

  await emitHubEvent(c.env, {
    type: 'LOAD_STATUS_CHANGED',
    channel: 'ops:all',
    payload: { loadId, ebolStage: candidate.stage, seq: candidate.seq, blockHash: candidate.blockHash },
  });

  return c.json({ success: true, block: candidate, verification: check }, 201);
});

/** Download cryptographically certified eBOL PDF with verification URL and Code-128 barcode. */
ebolRoutes.get('/ebol/:loadId/certificate.pdf', async (c) => {
  const loadId = c.req.param('loadId');
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(ebolBlocks)
    .where(eq(ebolBlocks.loadId, loadId))
    .orderBy(asc(ebolBlocks.seq));
  if (rows.length === 0) return c.json({ error: 'No eBOL blocks found for this load.' }, 404);

  const blocks = rows.map(rowToBlockRecord);
  const baseUrl = c.env.PUBLIC_APP_URL || 'https://brotransport.com';
  const pdfBytes = await generateEbolCertificatePdf(loadId, blocks, `${baseUrl}/verify/${encodeURIComponent(loadId)}`);

  return new Response(pdfBytes as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${loadId}_eBOL_certificate.pdf"`,
    },
  });
});
