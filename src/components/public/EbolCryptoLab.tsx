import React, { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, KeyRound, Bug, RotateCcw, Download, FileCheck2 } from 'lucide-react';
import type { EbolBlockRecord } from '@bro/contracts';
import {
  computeGenesisHash,
  createSignedEbolBlock,
  generateActorKeyPair,
  verifyEbolChain,
  type EbolChainVerificationResult,
} from '../../lib/ebolCrypto';

interface EbolCryptoLabProps {
  initialLoadId?: string;
}

export default function EbolCryptoLab({ initialLoadId = 'BROP-2026-9948' }: EbolCryptoLabProps) {
  const [loadId, setLoadId] = useState(initialLoadId);
  const [blocks, setBlocks] = useState<EbolBlockRecord[]>([]);
  const [verification, setVerification] = useState<EbolChainVerificationResult | null>(null);
  const [genesisHash, setGenesisHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const runLocalVerification = async (targetLoadId: string, chain: EbolBlockRecord[]) => {
    const gen = await computeGenesisHash(targetLoadId);
    setGenesisHash(gen);
    if (chain.length === 0) {
      setVerification(null);
      return;
    }
    const res = await verifyEbolChain(targetLoadId, chain);
    setVerification(res);
  };

  // Load persisted chain from API if present
  useEffect(() => {
    let active = true;
    const loadFromApi = async () => {
      try {
        const res = await fetch(`/api/ebol/${encodeURIComponent(loadId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { blocks?: EbolBlockRecord[] };
        if (active && data.blocks && data.blocks.length > 0) {
          setBlocks(data.blocks);
          setTampered(false);
          await runLocalVerification(loadId, data.blocks);
        } else if (active) {
          setBlocks([]);
          setVerification(null);
          setGenesisHash(await computeGenesisHash(loadId));
        }
      } catch {
        if (active) setGenesisHash(await computeGenesisHash(loadId));
      }
    };
    void loadFromApi();
    return () => {
      active = false;
    };
  }, [loadId]);

  const signNextStage = async () => {
    setBusy(true);
    setStatusMsg(null);
    setTampered(false);
    try {
      const stages: Array<{
        stage: EbolBlockRecord['stage'];
        actorRole: EbolBlockRecord['actorRole'];
        actorName: string;
        gpsLat: number;
        gpsLon: number;
        payload: Record<string, unknown>;
      }> = [
        {
          stage: 'SHIPPER_INIT',
          actorRole: 'shipper',
          actorName: 'Owen MacLeod (Cavendish Valley Produce)',
          gpsLat: 46.3959,
          gpsLon: -63.7876,
          payload: { commodity: 'Fresh PEI Potatoes', weightLbs: 38400, pallets: 24, setpointC: 4.0, scac: 'BROP' },
        },
        {
          stage: 'CARRIER_PICKUP',
          actorRole: 'driver',
          actorName: 'Liam Gallant (#BRO Unit RF-4221)',
          gpsLat: 46.3961,
          gpsLon: -63.7872,
          payload: { sealNumber: 'BROP-SEAL-8843', reeferTempC: 4.1, condition: 'INTACT_ZERO_OSD' },
        },
        {
          stage: 'CONSIGNEE_POD',
          actorRole: 'consignee',
          actorName: 'New England Fresh Market Receiving Dock #4',
          gpsLat: 42.3601,
          gpsLon: -71.0589,
          payload: { receivedPallets: 24, receivedTempC: 4.0, osdExceptions: 'NONE', custodySettled: true },
        },
      ];

      const nextSpec = stages[blocks.length];
      if (!nextSpec) return;

      // Real browser Web Crypto ECDSA P-256 keypair generation & signature!
      const keyPair = await generateActorKeyPair();
      const prevHash = blocks.length === 0 ? await computeGenesisHash(loadId) : blocks[blocks.length - 1].blockHash;

      const signedBlock = await createSignedEbolBlock({
        loadId,
        seq: blocks.length + 1,
        stage: nextSpec.stage,
        actorRole: nextSpec.actorRole,
        actorName: nextSpec.actorName,
        privateKey: keyPair.privateKey,
        publicKeyJwk: keyPair.publicKeyJwk,
        prevHash,
        payload: nextSpec.payload,
        gpsLat: nextSpec.gpsLat,
        gpsLon: nextSpec.gpsLon,
        signedAt: Date.now(),
      });

      // Attempt server persistence (verifies signature server-side in Cloudflare D1!)
      let persistedNote = 'Verified locally via browser Web Crypto ECDSA P-256.';
      try {
        const res = await fetch(`/api/ebol/${encodeURIComponent(loadId)}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signedBlock),
        });
        if (res.ok) {
          persistedNote = 'ECDSA P-256 signature verified server-side & committed to Cloudflare D1 ledger.';
        }
      } catch {
        // Offline / static preview still runs 100% real local Web Crypto verification
      }

      const nextChain = [...blocks, signedBlock];
      setBlocks(nextChain);
      await runLocalVerification(loadId, nextChain);
      setStatusMsg(persistedNote);
    } finally {
      setBusy(false);
    }
  };

  /** Signs all 3 custody handoffs sequentially with fresh browser Web Crypto ECDSA P-256 keypairs. */
  const signAllThreeStages = async () => {
    setBusy(true);
    setStatusMsg(null);
    setTampered(false);
    try {
      const stages: Array<{
        stage: EbolBlockRecord['stage'];
        actorRole: EbolBlockRecord['actorRole'];
        actorName: string;
        gpsLat: number;
        gpsLon: number;
        payload: Record<string, unknown>;
      }> = [
        {
          stage: 'SHIPPER_INIT',
          actorRole: 'shipper',
          actorName: 'Cavendish Valley Produce (Shipper Dispatch)',
          gpsLat: 46.3959,
          gpsLon: -63.7876,
          payload: { commodity: 'Fresh PEI Potatoes', weightLbs: 38400, pallets: 24, setpointC: 4.0, scac: 'BROP' },
        },
        {
          stage: 'CARRIER_PICKUP',
          actorRole: 'driver',
          actorName: '#BRO Operator · Unit RF-4221',
          gpsLat: 46.3961,
          gpsLon: -63.7872,
          payload: { sealNumber: 'BROP-SEAL-8843', reeferTempC: 4.1, condition: 'INTACT_ZERO_OSD' },
        },
        {
          stage: 'CONSIGNEE_POD',
          actorRole: 'consignee',
          actorName: 'New England Fresh Market Receiving Dock #4',
          gpsLat: 42.3601,
          gpsLon: -71.0589,
          payload: { receivedPallets: 24, receivedTempC: 4.0, osdExceptions: 'NONE', custodySettled: true },
        },
      ];

      let runningChain = [...blocks];
      let genesis = await computeGenesisHash(loadId);
      let serverCount = 0;

      for (let i = runningChain.length; i < stages.length; i++) {
        const spec = stages[i];
        const keyPair = await generateActorKeyPair();
        const prevHash = runningChain.length === 0 ? genesis : runningChain[runningChain.length - 1].blockHash;
        const signedBlock = await createSignedEbolBlock({
          loadId,
          seq: runningChain.length + 1,
          stage: spec.stage,
          actorRole: spec.actorRole,
          actorName: spec.actorName,
          privateKey: keyPair.privateKey,
          publicKeyJwk: keyPair.publicKeyJwk,
          prevHash,
          payload: spec.payload,
          gpsLat: spec.gpsLat,
          gpsLon: spec.gpsLon,
          signedAt: Date.now() + i * 1500,
        });
        try {
          const res = await fetch(`/api/ebol/${encodeURIComponent(loadId)}/sign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedBlock),
          });
          if (res.ok) serverCount++;
        } catch {
          // Local Web Crypto chain remains valid offline
        }
        runningChain = [...runningChain, signedBlock];
      }

      setBlocks(runningChain);
      await runLocalVerification(loadId, runningChain);
      setStatusMsg(
        serverCount > 0
          ? `Full 3-party ECDSA P-256 chain signed & committed (${serverCount} new block(s) written to Cloudflare D1).`
          : 'Full 3-party ECDSA P-256 custody chain generated & verified via browser Web Crypto API.',
      );
    } finally {
      setBusy(false);
    }
  };

  /** Mutates 1 single byte in Block 1's cargo payload to prove real cryptographic tamper detection! */
  const simulateOneByteTamper = async () => {
    if (blocks.length === 0) return;
    const cloned = blocks.map((b) => ({ ...b }));
    cloned[0] = {
      ...cloned[0],
      payloadJson: cloned[0].payloadJson.replace('38400', '38401'),
    };
    setBlocks(cloned);
    setTampered(true);
    setStatusMsg('Simulated 1-byte forgery on Block #1 (weightLbs altered from 38400 -> 38401). Watch Web Crypto reject it!');
    await runLocalVerification(loadId, cloned);
  };

  const downloadProofJson = () => {
    const bundle = {
      protocol: 'BRO_ECDSA_P256_EBOL_V1',
      loadId,
      genesisHash,
      verifiedAt: new Date().toISOString(),
      verification,
      blocks,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${loadId}_verifiable_ebol_proof.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header & Lookup Bar */}
      <div className="rounded-3xl surface-ceramic p-6 sm:p-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-bro-cyan">
            Web Crypto ECDSA P-256 · SHA-256 Custody Chain
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
            Cryptographic eBOL Verifier &amp; Tamper Lab
          </h1>
          <p className="text-xs sm:text-sm text-slate-400">
            Sign Shipper Release, Driver Pickup, and Consignee POD with real asymmetric keys—verified live via{' '}
            <code className="text-bro-cyan">crypto.subtle.verify()</code>.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="Load or eBOL Reference ID"
            value={loadId}
            onChange={(e) => setLoadId(e.target.value.trim() || 'BROP-2026-9948')}
            className="bg-[#060912] border border-white/15 rounded-full px-4 py-2 font-mono text-xs text-white outline-none focus:border-bro-cyan w-44"
          />
          {blocks.length > 0 && (
            <button
              type="button"
              onClick={downloadProofJson}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border border-white/15 hover:border-bro-cyan text-xs font-medium text-slate-200 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" /> JSON-LD
            </button>
          )}
        </div>
      </div>

      {/* Live Cryptographic Seal Banner */}
      <div
        className={`rounded-3xl border p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
          verification === null
            ? 'surface-ceramic'
            : verification.valid
              ? 'border-emerald-500/40 bg-emerald-950/25'
              : 'border-rose-500/50 bg-rose-950/35'
        }`}
      >
        <div className="flex items-center gap-3">
          {verification === null ? (
            <KeyRound className="w-6 h-6 text-bro-cyan shrink-0" />
          ) : verification.valid ? (
            <ShieldCheck className="w-6 h-6 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-6 h-6 text-rose-400 shrink-0" />
          )}
          <div className="font-mono text-xs space-y-0.5">
            <div className="font-bold text-white uppercase">
              {verification === null
                ? 'READY TO SIGN LIVE 3-PARTY ECDSA P-256 CUSTODY CHAIN'
                : verification.valid
                  ? `CRYPTOGRAPHICALLY VERIFIED (${verification.verifiedCount} SIGNED BLOCKS)`
                  : `TAMPER DETECTED ON BLOCK #${verification.brokenBlockSeq} — SIGNATURE REJECTED`}
            </div>
            <div className="text-[11px] text-slate-300">
              {verification && !verification.valid
                ? verification.reason
                : statusMsg || `Domain Genesis Seed Hash: ${genesisHash.slice(0, 32)}...`}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {blocks.length < 3 && !tampered && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={signNextStage}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white hover:bg-bro-cyan text-black text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>
                  {busy
                    ? 'Signing ECDSA...'
                    : blocks.length === 0
                      ? 'Sign Step 1: Shipper'
                      : blocks.length === 1
                        ? 'Sign Step 2: Driver'
                        : 'Sign Step 3: Consignee POD'}
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void signAllThreeStages()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-bro-cyan text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors"
              >
                Auto-Sign All 3 Handoffs
              </button>
            </>
          )}
          {blocks.length > 0 && !tampered && (
            <button
              type="button"
              onClick={simulateOneByteTamper}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-rose-500/50 bg-rose-950/30 hover:bg-rose-950/60 text-rose-200 text-xs font-semibold cursor-pointer"
            >
              <Bug className="w-3.5 h-3.5" /> Simulate 1-Byte Tamper
            </button>
          )}
          {blocks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setBlocks([]);
                setVerification(null);
                setTampered(false);
                setStatusMsg(null);
              }}
              className="inline-flex items-center gap-1 px-3 py-2 rounded border border-white/15 text-slate-300 hover:text-white font-mono text-xs cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Reset Lab
            </button>
          )}
          {blocks.length === 3 && verification?.valid && (
            <a
              href={`/api/ebol/${encodeURIComponent(loadId)}/certificate.pdf`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-bro-gold text-black font-mono text-xs font-bold uppercase"
            >
              <FileCheck2 className="w-3.5 h-3.5" /> Certificate PDF
            </a>
          )}
        </div>
      </div>

      {/* Block Chain Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {blocks.map((blk) => {
          const isBroken = verification && !verification.valid && verification.brokenBlockSeq === blk.seq;
          return (
            <div
              key={blk.id}
              className={`rounded-lg border p-4 space-y-3 font-mono text-xs ${
                isBroken
                  ? 'border-rose-500 bg-rose-950/30'
                  : 'border-bro-cyan/30 bg-bro-obsidian/85'
              }`}
            >
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-bro-gold font-bold">BLOCK #{blk.seq} · {blk.stage}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${isBroken ? 'bg-rose-600 text-white' : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'}`}>
                  {isBroken ? 'FORGED' : 'ECDSA OK'}
                </span>
              </div>
              <div className="text-white font-sans font-semibold text-sm">{blk.actorName}</div>
              <div className="text-[10px] text-slate-400">
                GPS: {blk.gpsLat.toFixed(4)}, {blk.gpsLon.toFixed(4)} · {new Date(blk.signedAt).toLocaleTimeString()}
              </div>
              <div className="p-2.5 rounded bg-bro-steel/70 border border-white/10 text-[10px] text-slate-200 break-all">
                <div className="text-slate-500 uppercase mb-1">Canonical Payload:</div>
                {blk.payloadJson}
              </div>
              <div className="space-y-1 text-[10px] text-slate-400 break-all">
                <div><span className="text-slate-500">PREV:</span> {blk.prevHash.slice(0, 28)}…</div>
                <div><span className="text-bro-cyan">HASH:</span> {blk.blockHash.slice(0, 28)}…</div>
                <div><span className="text-bro-gold">SIG:</span> {blk.ecdsaSignatureB64.slice(0, 28)}…</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
