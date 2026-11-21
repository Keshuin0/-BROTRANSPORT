import { Hono } from 'hono';
import { asc, eq, or } from 'drizzle-orm';
import { createDb, ebolBlocks, loads, auditLogs } from '@bro/db';
import { EbolSignRequestSchema, type EbolBlockRecord } from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { verifyEbolChain } from '../../../src/lib/ebolCrypto.js';
import { generateEbolCertificatePdf } from '../../services/pdfGenerator.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const ebolRoutes = new Hono<ApiEnv>();

function safeParseJwk(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function rowToBlockRecord(row: typeof ebolBlocks.$inferSelect): EbolBlockRecord {
  return {
    id: row.id,
    seq: row.seq,
    loadId: row.loadId,
    stage: row.stage,
    actorRole: row.actorRole as EbolBlockRecord['actorRole'],
    actorName: row.actorName,
    signerPublicKeyJwk: safeParseJwk(row.signerPublicKeyJwk),
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

async function resolveEbolChainForLoad(
  db: ReturnType<typeof createDb>,
  rawLoadId: string,
): Promise<{
  resolvedLoadId: string;
  loadNumber: string;
  rows: (typeof ebolBlocks.$inferSelect)[];
  loadExists: boolean;
}> {
  let rows = await db
    .select()
    .from(ebolBlocks)
    .where(eq(ebolBlocks.loadId, rawLoadId))
    .orderBy(asc(ebolBlocks.seq));

  const loadMatches = await db
    .select({ id: loads.id, loadNumber: loads.loadNumber })
    .from(loads)
    .where(or(eq(loads.id, rawLoadId), eq(loads.loadNumber, rawLoadId)))
    .limit(1);
  const matchedLoad = loadMatches[0];

  if (rows.length === 0 && matchedLoad) {
    const alternateKey = matchedLoad.id === rawLoadId ? matchedLoad.loadNumber : matchedLoad.id;
    const altRows = await db
      .select()
      .from(ebolBlocks)
      .where(eq(ebolBlocks.loadId, alternateKey))
      .orderBy(asc(ebolBlocks.seq));
    if (altRows.length > 0) {
      rows = altRows;
      return {
        resolvedLoadId: alternateKey,
        loadNumber: matchedLoad.loadNumber,
        rows,
        loadExists: true,
      };
    }
  }

  return {
    resolvedLoadId: rows[0]?.loadId ?? matchedLoad?.id ?? rawLoadId,
    loadNumber: matchedLoad?.loadNumber ?? rawLoadId,
    rows,
    loadExists: Boolean(matchedLoad),
  };
}

/** Public verifiable eBOL chain read endpoint for `/verify/[ebolId]`. */
ebolRoutes.get('/ebol/:loadId', async (c) => {
  const rawLoadId = c.req.param('loadId');
  const db = createDb(c.env.DB);
  const { resolvedLoadId, loadNumber, rows } = await resolveEbolChainForLoad(db, rawLoadId);

  const blocks = rows.map(rowToBlockRecord);
  const verification =
    blocks.length > 0 ? await verifyEbolChain(resolvedLoadId, blocks) : { valid: true, verifiedCount: 0 };

  return c.json({ loadId: resolvedLoadId, requestedLoadId: rawLoadId, loadNumber, blocks, verification });
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
  const rawLoadId = c.req.param('loadId');
  const db = createDb(c.env.DB);
  const { resolvedLoadId, loadNumber, rows, loadExists } = await resolveEbolChainForLoad(db, rawLoadId);
  if (rows.length === 0 && !loadExists) {
    return c.json({ error: 'No eBOL blocks or load found for this identifier.' }, 404);
  }

  const blocks = rows.map(rowToBlockRecord);
  const baseUrl = c.env.PUBLIC_APP_URL || 'https://brotransport.com';
  const displayRef = loadNumber || resolvedLoadId;
  const pdfBytes = await generateEbolCertificatePdf(
    displayRef,
    blocks,
    `${baseUrl}/verify/${encodeURIComponent(displayRef)}`,
  );

  const safeRef = displayRef.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(pdfBytes as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeRef}_eBOL_certificate.pdf"`,
    },
  });
});
