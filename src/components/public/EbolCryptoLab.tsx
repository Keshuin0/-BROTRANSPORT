import { useState, useEffect } from 'react';
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

export default function EbolCryptoLab({ initialLoadId = 'load_9948' }: EbolCryptoLabProps) {
  const [loadIdInput, setLoadIdInput] = useState(initialLoadId);
  const [loadId, setLoadId] = useState(initialLoadId);
  const [canonicalLoadId, setCanonicalLoadId] = useState(initialLoadId);
  const [resolvedLoadNumber, setResolvedLoadNumber] = useState<string | null>(
    initialLoadId === 'load_9948' ? 'BROP-2026-9948' : null,
  );
  const [blocks, setBlocks] = useState<EbolBlockRecord[]>([]);
  const [verification, setVerification] = useState<EbolChainVerificationResult | null>(null);
  const [serverPersisted, setServerPersisted] = useState(false);
  const [genesisHash, setGenesisHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    setLoadIdInput(initialLoadId);
    setLoadId(initialLoadId);
    setCanonicalLoadId(initialLoadId);
    setResolvedLoadNumber(initialLoadId === 'load_9948' ? 'BROP-2026-9948' : null);
  }, [initialLoadId]);

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
        if (!res.ok) {
          if (active) {
            setServerPersisted(false);
            setGenesisHash(await computeGenesisHash(loadId));
          }
          return;
        }
        const data = (await res.json()) as {
          loadId?: string;
          loadNumber?: string;
          blocks?: EbolBlockRecord[];
          verification?: EbolChainVerificationResult & { serverPersisted?: boolean };
        };
        const resolvedId = data.loadId || loadId;
        if (!active) return;

        setCanonicalLoadId(resolvedId);
        setResolvedLoadNumber(
          data.loadNumber || (resolvedId === 'load_9948' ? 'BROP-2026-9948' : null),
        );

        if (data.blocks && data.blocks.length > 0) {
          setBlocks(data.blocks);
          setTampered(false);
          setServerPersisted(Boolean(data.verification?.serverPersisted ?? true));
          await runLocalVerification(resolvedId, data.blocks);
        } else {
          setBlocks([]);
          setVerification(null);
          setServerPersisted(false);
          setGenesisHash(await computeGenesisHash(resolvedId));
        }
      } catch {
        if (active) {
          setServerPersisted(false);
          setGenesisHash(await computeGenesisHash(loadId));
        }
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

      const targetId = canonicalLoadId || loadId;
      // Real browser Web Crypto ECDSA P-256 keypair generation & signature!
      const keyPair = await generateActorKeyPair();
      const prevHash = blocks.length === 0 ? await computeGenesisHash(targetId) : blocks[blocks.length - 1].blockHash;

      const signedBlock = await createSignedEbolBlock({
        loadId: targetId,
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
      let blockPersisted = false;
      try {
        const res = await fetch(`/api/ebol/${encodeURIComponent(targetId)}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signedBlock),
        });
        if (res.ok) {
          blockPersisted = true;
          persistedNote = 'ECDSA P-256 signature verified server-side & committed to Cloudflare D1 ledger.';
        }
      } catch {
        // Offline / static preview still runs 100% real local Web Crypto verification
      }

      const nextChain = [...blocks, signedBlock];
      setBlocks(nextChain);
      setServerPersisted(blockPersisted && (blocks.length === 0 || serverPersisted));
      await runLocalVerification(targetId, nextChain);
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

      const targetId = canonicalLoadId || loadId;
      let runningChain = [...blocks];
      const genesis = await computeGenesisHash(targetId);
      let serverCount = 0;
      let allPersisted = blocks.length === 0 || serverPersisted;

      for (let i = runningChain.length; i < stages.length; i++) {
        const spec = stages[i];
        const keyPair = await generateActorKeyPair();
        const prevHash = runningChain.length === 0 ? genesis : runningChain[runningChain.length - 1].blockHash;
        const signedBlock = await createSignedEbolBlock({
          loadId: targetId,
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
          const res = await fetch(`/api/ebol/${encodeURIComponent(targetId)}/sign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedBlock),
          });
          if (res.ok) {
            serverCount++;
          } else {
            allPersisted = false;
          }
        } catch {
          allPersisted = false;
        }
        runningChain = [...runningChain, signedBlock];
      }

      setBlocks(runningChain);
      setServerPersisted(allPersisted && (serverCount > 0 || serverPersisted));
      await runLocalVerification(targetId, runningChain);
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
    setServerPersisted(false);
    setStatusMsg('Simulated 1-byte forgery on Block #1 (weightLbs altered from 38400 -> 38401). Watch Web Crypto reject it!');
    await runLocalVerification(canonicalLoadId || loadId, cloned);
  };

  const downloadProofJson = () => {
    const bundle = {
      protocol: 'BRO_ECDSA_P256_EBOL_V1',
      loadId: canonicalLoadId || loadId,
      loadNumber: resolvedLoadNumber,
      genesisHash,
      verifiedAt: new Date().toISOString(),
      verification,
      blocks,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${canonicalLoadId || loadId}_verifiable_ebol_proof.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canDownloadCertificate =
    blocks.length === 3 && Boolean(verification?.valid) && !tampered && serverPersisted;

  return (
    <div className="space-y-6">
      {/* Header & Lookup Bar */}
      <div className="rounded-3xl surface-ceramic p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-bro-cyan">
            Web Crypto ECDSA P-256 · SHA-256 Custody Chain
          </div>
          <h1 className="text-title-fluid font-display font-bold text-white">
            Cryptographic eBOL Verifier &amp; Tamper Lab
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-2xl">
            Sign Shipper Release, Driver Pickup, and Consignee POD with real asymmetric keys—verified live via{' '}
            <code className="text-bro-cyan">crypto.subtle.verify()</code>.
          </p>
        </div>

        <div className="space-y-1.5 shrink-0">
          <label htmlFor="ebol-load-id" className="block font-mono text-[11px] text-slate-300">
            Load / eBOL Reference ({resolvedLoadNumber ? `${resolvedLoadNumber} / ${canonicalLoadId}` : 'BROP-2026-9948 / load_9948'})
          </label>
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              id="ebol-load-id"
              type="text"
              placeholder="load_9948 or BROP-2026-9948"
              value={loadIdInput}
              onChange={(e) => {
                const raw = e.target.value;
                setLoadIdInput(raw);
                const trimmed = raw.trim();
                if (trimmed.length > 0) {
                  setLoadId(trimmed);
                }
              }}
              onBlur={() => {
                if (!loadIdInput.trim()) {
                  setLoadIdInput('load_9948');
                  setLoadId('load_9948');
                }
              }}
              className="min-h-[44px] bg-[#060912] border border-white/15 rounded-full px-4 py-2 font-mono text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan w-full sm:w-52"
            />
            {blocks.length > 0 && (
              <button
                type="button"
                onClick={downloadProofJson}
                className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] hover:border-bro-cyan text-xs font-medium text-slate-200 cursor-pointer transition-colors"
              >
                <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>JSON-LD</span>
              </button>
            )}
          </div>
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
            <KeyRound className="w-6 h-6 text-bro-cyan shrink-0" aria-hidden="true" />
          ) : verification.valid ? (
            <ShieldCheck className="w-6 h-6 text-emerald-400 shrink-0" aria-hidden="true" />
          ) : (
            <ShieldAlert className="w-6 h-6 text-rose-400 shrink-0" aria-hidden="true" />
          )}
          <div className="font-mono text-xs space-y-0.5 min-w-0">
            <div className="font-bold text-white uppercase">
              {verification === null
                ? 'READY TO SIGN LIVE 3-PARTY ECDSA P-256 CUSTODY CHAIN'
                : verification.valid
                  ? `CRYPTOGRAPHICALLY VERIFIED (${verification.verifiedCount} SIGNED BLOCKS)`
                  : `TAMPER DETECTED ON BLOCK #${verification.brokenBlockSeq} — SIGNATURE REJECTED`}
            </div>
            <div className="text-[11px] text-slate-300 break-words">
              {verification && !verification.valid
                ? verification.reason
                : statusMsg || `Domain Genesis Seed Hash: ${genesisHash.slice(0, 32)}...`}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {blocks.length < 3 && !tampered && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={signNextStage}
                className="min-h-[44px] inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-white hover:bg-bro-cyan text-black text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors"
              >
                <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
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
                className="min-h-[44px] inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-bro-gold hover:bg-amber-400 text-black text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors"
              >
                Auto-Sign All 3 Handoffs
              </button>
            </>
          )}
          {blocks.length > 0 && !tampered && (
            <button
              type="button"
              onClick={simulateOneByteTamper}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-rose-500/50 bg-rose-950/30 hover:bg-rose-950/60 text-rose-200 text-xs font-semibold cursor-pointer transition-colors"
            >
              <Bug className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Simulate 1-Byte Tamper
            </button>
          )}
          {blocks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setBlocks([]);
                setVerification(null);
                setTampered(false);
                setServerPersisted(false);
                setStatusMsg(null);
              }}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-white/15 bg-white/[0.04] hover:border-white/30 text-slate-200 hover:text-white text-xs font-medium cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Reset Lab
            </button>
          )}
          {canDownloadCertificate && (
            <a
              href={`/api/ebol/${encodeURIComponent(canonicalLoadId || loadId)}/certificate.pdf`}
              target="_blank"
              rel="noreferrer"
              className="min-h-[44px] inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-bro-gold hover:bg-amber-400 text-black text-xs font-semibold transition-colors"
            >
              <FileCheck2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Download Certificate PDF
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
              className={`rounded-2xl border p-5 space-y-3 font-mono text-xs ${
                isBroken
                  ? 'border-rose-500 bg-rose-950/30'
                  : 'surface-ceramic border-bro-cyan/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-white/[0.08] pb-2.5">
                <span className="text-bro-gold font-bold">BLOCK #{blk.seq} · {blk.stage}</span>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${
                    isBroken
                      ? 'bg-rose-600 text-white'
                      : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                  }`}
                >
                  {isBroken ? 'FORGED' : 'ECDSA OK'}
                </span>
              </div>
              <div className="text-white font-sans font-semibold text-sm">{blk.actorName}</div>
              <div className="text-[11px] text-slate-300 tabular-nums">
                GPS: {blk.gpsLat.toFixed(4)}, {blk.gpsLon.toFixed(4)} · {new Date(blk.signedAt).toLocaleTimeString()}
              </div>
              <div className="p-3 rounded-xl bg-[#060912] border border-white/[0.08] text-[11px] text-slate-200 break-all">
                <div className="text-slate-300 uppercase mb-1">Canonical Payload:</div>
                {blk.payloadJson}
              </div>
              <div className="space-y-1 text-[11px] text-slate-300 break-all">
                <div><span className="text-slate-300 font-semibold">PREV:</span> {blk.prevHash.slice(0, 28)}…</div>
                <div><span className="text-bro-cyan font-semibold">HASH:</span> {blk.blockHash.slice(0, 28)}…</div>
                <div><span className="text-bro-gold font-semibold">SIG:</span> {blk.ecdsaSignatureB64.slice(0, 28)}…</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
