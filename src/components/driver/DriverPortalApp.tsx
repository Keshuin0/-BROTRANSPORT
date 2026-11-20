import React, { useState, useEffect, useCallback } from 'react';
import {
  Truck,
  MapPin,
  Navigation,
  Camera,
  ClipboardCheck,
  KeyRound,
  DollarSign,
  AlertTriangle,
  Clock,
  FileText,
  Download,
  ExternalLink,
  RefreshCw,
  Loader2,
  ShieldCheck,
  WifiOff,
  Radio,
} from 'lucide-react';
import {
  StopCheckinSchema,
  type EquipmentType,
  type LoadDirection,
  type LoadStatus,
  type OcrStatus,
  type EbolBlockRecord,
  type EbolSignRequest,
} from '@bro/contracts';
import { enqueueOfflineSubmission } from '../../lib/offlineDb';
import {
  generateActorKeyPair,
  createSignedEbolBlock,
  computeGenesisHash,
} from '../../lib/ebolCrypto';
import OfflineSyncDrawer from './OfflineSyncDrawer';
import MobileDocScanner from './MobileDocScanner';
import DvirInspectionForm, { type DvirEquipmentUnit } from './DvirInspectionForm';

type DriverTab = 'trip' | 'docs' | 'dvir' | 'ebol' | 'pay';

interface DriverProfile {
  id: string;
  userId: string | null;
  organizationId: string | null;
  fullName: string;
  phone: string;
  email: string;
  equipmentDivision: EquipmentType;
  preferredLanes: string;
  licenseNumber: string | null;
  licenseClass: string | null;
  licenseExpiry: number | null;
  medicalCardExpiry: number | null;
  fastCardNumber: string | null;
  payModel: 'cpm' | 'percent_gross';
  payRateValue: number;
  status: 'applicant' | 'active' | 'on_leave' | 'inactive';
}

interface DriverLoad {
  id: string;
  loadNumber: string;
  shipperOrgId: string;
  assignedDriverId: string | null;
  tractorId: string | null;
  trailerId: string | null;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  status: LoadStatus;
  commodity: string;
  weightLbs: number;
  loadedMiles: number;
  tempSetpointC: number | null;
  isFoodFda: boolean;
  rateCustomerCents: number;
  rateCarrierCents: number;
  currency: 'CAD' | 'USD';
  detentionMinutes: number;
  updatedAt: number;
}

interface DriverStop {
  id: string;
  loadId: string;
  seq: number;
  stopType: 'pickup' | 'border_crossing' | 'delivery';
  facilityName: string;
  address: string;
  lat: number;
  lon: number;
  apptStart: number;
  apptEnd: number;
  arrivedAt: number | null;
  departedAt: number | null;
}

interface DriverDocument {
  id: string;
  loadId: string | null;
  docType: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
  ocrStatus: OcrStatus;
  ocrConfidence: number | null;
  reviewNotes: string | null;
  createdAt: number;
}

interface DriverSettlement {
  id: string;
  settlementNumber: string;
  driverId: string;
  periodStart: number;
  periodEnd: number;
  loadsJson: string;
  deductionsJson: string;
  grossPayCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  netPayCents: number;
  currency: 'CAD' | 'USD';
  status: 'draft' | 'finalized' | 'paid';
  createdAt: number;
}

interface DriverDashboardPayload {
  driver: DriverProfile | null;
  assignedLoads: DriverLoad[];
  stopsByLoad: Record<string, DriverStop[]>;
  recentDocs: DriverDocument[];
  settlements: DriverSettlement[];
  fleetUnits: DvirEquipmentUnit[];
}

interface StopFeedback {
  event: 'arrived' | 'departed';
  edi214Issued: boolean;
  queuedOffline?: boolean;
  loadStatus?: string;
  timestampMs: number;
}

const DIRECTION_LABELS: Record<LoadDirection, string> = {
  ca_to_us: 'CA → US Export',
  us_to_ca: 'US → CA Import',
  domestic_ca: 'Domestic Canada',
  domestic_us: 'Domestic U.S.',
};

const EQUIPMENT_LABELS: Record<EquipmentType, string> = {
  dry_van: '53ft Dry Van',
  reefer: '53ft Reefer',
  flatbed: '53ft Flatbed',
};

function formatMoneyCents(cents: number, currency: 'CAD' | 'USD'): string {
  const formatted = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return `${formatted} ${currency}`;
}

function formatDateTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(ms: number | null): string {
  if (!ms) return 'Not on file';
  return new Date(ms).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function computeDaysUntil(expiryMs: number | null): number | null {
  if (!expiryMs) return null;
  return Math.ceil((expiryMs - Date.now()) / 86_400_000);
}

function ocrStatusBadgeStyle(status: OcrStatus): string {
  switch (status) {
    case 'verified':
      return 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300';
    case 'awaiting_review':
      return 'bg-amber-500/20 border-bro-gold/60 text-bro-gold';
    case 'extracting':
      return 'bg-cyan-500/20 border-bro-cyan/60 text-bro-cyan';
    case 'rejected':
      return 'bg-rose-500/20 border-bro-crimson text-rose-200';
    case 'pending':
    default:
      return 'bg-slate-800/80 border-white/15 text-slate-300';
  }
}

async function captureBrowserGps(fallbackLat: number, fallbackLon: number): Promise<{
  lat: number;
  lon: number;
  source: 'gps' | 'stop_fallback';
}> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { lat: fallbackLat, lon: fallbackLon, source: 'stop_fallback' };
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: Number(pos.coords.latitude.toFixed(6)),
          lon: Number(pos.coords.longitude.toFixed(6)),
          source: 'gps',
        });
      },
      () => {
        resolve({ lat: fallbackLat, lon: fallbackLon, source: 'stop_fallback' });
      },
      { enableHighAccuracy: true, timeout: 4000, maximumAge: 60_000 },
    );
  });
}

export default function DriverPortalApp() {
  const [activeTab, setActiveTab] = useState<DriverTab>('trip');
  const [dashboard, setDashboard] = useState<DriverDashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Stop Check-In state
  const [checkingInKey, setCheckingInKey] = useState<string | null>(null);
  const [stopFeedback, setStopFeedback] = useState<Record<string, StopFeedback>>({});
  const [stopError, setStopError] = useState<string | null>(null);

  // eBOL ECDSA P-256 Sign state
  const [ebolLoadId, setEbolLoadId] = useState<string>('');
  const [ebolChain, setEbolChain] = useState<EbolBlockRecord[]>([]);
  const [ebolChainLoading, setEbolChainLoading] = useState(false);
  const [ebolSignerName, setEbolSignerName] = useState<string>('');
  const [ebolSealNumber, setEbolSealNumber] = useState<string>('');
  const [ebolPieces, setEbolPieces] = useState<string>('24');
  const [ebolNotes, setEbolNotes] = useState<string>('Trailer sealed, reefer/deck verified, cargo intact at pickup.');
  const [ebolSigning, setEbolSigning] = useState(false);
  const [ebolError, setEbolError] = useState<string | null>(null);
  const [ebolSuccess, setEbolSuccess] = useState<{
    loadId: string;
    seq: number;
    blockHash: string;
    thumbprint: string;
    signaturePreview: string;
    queuedOffline?: boolean;
  } | null>(null);

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);

    try {
      const res = await fetch('/api/driver/dashboard');
      const data = (await res.json().catch(() => ({}))) as DriverDashboardPayload & { error?: string };
      if (!res.ok) {
        setLoadError(data.error || `Unable to load Driver Portal (HTTP ${res.status}).`);
        return;
      }
      setDashboard(data);
      if (data.assignedLoads.length > 0) {
        setEbolLoadId((prev) => prev || data.assignedLoads[0].id);
      }
      if (data.driver?.fullName) {
        setEbolSignerName((prev) => prev || data.driver!.fullName);
      }
    } catch {
      setLoadError('Network unreachable. Offline Sync Vault remains available for queued submissions.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchDashboard(false);
  }, [fetchDashboard]);

  const fetchEbolChain = useCallback(async (loadId: string) => {
    if (!loadId) {
      setEbolChain([]);
      return;
    }
    setEbolChainLoading(true);
    setEbolError(null);
    try {
      const res = await fetch(`/api/ebol/${encodeURIComponent(loadId)}`);
      if (!res.ok) {
        setEbolChain([]);
        return;
      }
      const data = (await res.json()) as { blocks?: EbolBlockRecord[] };
      setEbolChain(Array.isArray(data.blocks) ? data.blocks : []);
    } catch {
      setEbolChain([]);
    } finally {
      setEbolChainLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'ebol' && ebolLoadId) {
      void fetchEbolChain(ebolLoadId);
    }
  }, [activeTab, ebolLoadId, fetchEbolChain]);

  const handleStopCheckin = async (load: DriverLoad, stop: DriverStop, event: 'arrived' | 'departed') => {
    const busyKey = `${stop.id}:${event}`;
    setCheckingInKey(busyKey);
    setStopError(null);

    try {
      const gps = await captureBrowserGps(stop.lat, stop.lon);
      const nowMs = Date.now();
      const rawPayload = {
        event,
        lat: gps.lat,
        lon: gps.lon,
        timestampMs: nowMs,
      };
      const parsed = StopCheckinSchema.safeParse(rawPayload);
      if (!parsed.success) {
        setStopError(parsed.error.issues[0]?.message || 'Invalid GPS check-in payload.');
        return;
      }

      const endpoint = `/api/driver/loads/${encodeURIComponent(load.id)}/stops/${encodeURIComponent(stop.id)}/checkin`;

      const queueOffline = async () => {
        await enqueueOfflineSubmission({
          kind: 'stop_update',
          endpoint,
          payload: parsed.data as unknown as Record<string, unknown>,
        });
        setStopFeedback((prev) => ({
          ...prev,
          [stop.id]: { event, edi214Issued: false, queuedOffline: true, timestampMs: nowMs },
        }));
      };

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueOffline();
        return;
      }

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.data),
        });
      } catch (err) {
        if (err instanceof TypeError) {
          await queueOffline();
          return;
        }
        throw err;
      }

      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        loadStatus?: LoadStatus;
        detentionMinutes?: number;
        edi214Issued?: boolean;
        error?: string;
      };

      if (!res.ok) {
        setStopError(data.error || `Check-in rejected (HTTP ${res.status}).`);
        return;
      }

      setStopFeedback((prev) => ({
        ...prev,
        [stop.id]: {
          event,
          edi214Issued: Boolean(data.edi214Issued),
          loadStatus: data.loadStatus,
          timestampMs: nowMs,
        },
      }));

      // Optimistically update stop & load status in local state
      setDashboard((prev) => {
        if (!prev) return prev;
        const updatedLoads = prev.assignedLoads.map((l) =>
          l.id === load.id
            ? {
                ...l,
                status: data.loadStatus ?? l.status,
                detentionMinutes: data.detentionMinutes ?? l.detentionMinutes,
              }
            : l,
        );
        const updatedStops = (prev.stopsByLoad[load.id] ?? []).map((s) =>
          s.id === stop.id
            ? {
                ...s,
                arrivedAt: event === 'arrived' ? nowMs : s.arrivedAt,
                departedAt: event === 'departed' ? nowMs : s.departedAt,
              }
            : s,
        );
        return {
          ...prev,
          assignedLoads: updatedLoads,
          stopsByLoad: { ...prev.stopsByLoad, [load.id]: updatedStops },
        };
      });
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Unable to record stop check-in.');
    } finally {
      setCheckingInKey(null);
    }
  };

  const handleSignEbolPickup = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setEbolError(null);
    setEbolSuccess(null);

    if (!ebolLoadId) {
      setEbolError('Select an assigned load to sign.');
      return;
    }
    const signer = ebolSignerName.trim();
    if (signer.length < 2) {
      setEbolError('Enter your legal driver name for the ECDSA P-256 custody signature.');
      return;
    }

    const load = dashboard?.assignedLoads.find((l) => l.id === ebolLoadId);
    const loadStops = dashboard?.stopsByLoad[ebolLoadId] ?? [];
    const pickupStop = loadStops.find((s) => s.stopType === 'pickup') ?? loadStops[0];

    setEbolSigning(true);
    try {
      // Refresh latest chain blocks when online so prevHash & seq are strictly contiguous
      let latestBlocks = ebolChain;
      if (typeof navigator === 'undefined' || navigator.onLine) {
        const chainRes = await fetch(`/api/ebol/${encodeURIComponent(ebolLoadId)}`).catch(() => null);
        if (chainRes?.ok) {
          const chainData = (await chainRes.json()) as { blocks?: EbolBlockRecord[] };
          latestBlocks = Array.isArray(chainData.blocks) ? chainData.blocks : [];
          setEbolChain(latestBlocks);
        }
      }

      const prevHash =
        latestBlocks.length > 0
          ? latestBlocks[latestBlocks.length - 1].blockHash
          : await computeGenesisHash(ebolLoadId);
      const nextSeq = latestBlocks.length + 1;

      const gps = await captureBrowserGps(pickupStop?.lat ?? 46.2382, pickupStop?.lon ?? -63.1311);
      const keyPair = await generateActorKeyPair();

      const custodyPayload = {
        loadId: ebolLoadId,
        loadNumber: load?.loadNumber ?? ebolLoadId,
        commodity: load?.commodity ?? 'Commercial Freight',
        weightLbs: load?.weightLbs ?? 0,
        equipmentType: load?.equipmentType ?? 'dry_van',
        sealNumber: ebolSealNumber.trim() || 'UNSEALED-VERIFIED',
        piecesVerified: Number.parseInt(ebolPieces, 10) || 1,
        conditionNotes: ebolNotes.trim(),
        gpsSource: gps.source,
      };

      const signedBlock = await createSignedEbolBlock({
        loadId: ebolLoadId,
        seq: nextSeq,
        stage: 'CARRIER_PICKUP',
        actorRole: 'driver',
        actorName: signer,
        privateKey: keyPair.privateKey,
        publicKeyJwk: keyPair.publicKeyJwk,
        prevHash,
        payload: custodyPayload,
        gpsLat: gps.lat,
        gpsLon: gps.lon,
      });

      const signRequest: EbolSignRequest = {
        loadId: signedBlock.loadId,
        stage: signedBlock.stage,
        actorRole: signedBlock.actorRole,
        actorName: signedBlock.actorName,
        signerPublicKeyJwk: signedBlock.signerPublicKeyJwk,
        payloadJson: signedBlock.payloadJson,
        payloadSha256: signedBlock.payloadSha256,
        prevHash: signedBlock.prevHash,
        blockHash: signedBlock.blockHash,
        ecdsaSignatureB64: signedBlock.ecdsaSignatureB64,
        gpsLat: signedBlock.gpsLat,
        gpsLon: signedBlock.gpsLon,
        signedAt: signedBlock.signedAt,
      };

      const endpoint = `/api/ebol/${encodeURIComponent(ebolLoadId)}/sign`;

      const queueOffline = async () => {
        await enqueueOfflineSubmission({
          kind: 'ebol_signature',
          endpoint,
          payload: signRequest as unknown as Record<string, unknown>,
        });
        setEbolSuccess({
          loadId: ebolLoadId,
          seq: nextSeq,
          blockHash: signedBlock.blockHash,
          thumbprint: keyPair.thumbprint,
          signaturePreview: signedBlock.ecdsaSignatureB64.slice(0, 36),
          queuedOffline: true,
        });
      };

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueOffline();
        return;
      }

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signRequest),
        });
      } catch (err) {
        if (err instanceof TypeError) {
          await queueOffline();
          return;
        }
        throw err;
      }

      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        block?: EbolBlockRecord;
        error?: string;
      };

      if (!res.ok) {
        setEbolError(data.error || `eBOL cryptographic verification rejected (HTTP ${res.status}).`);
        return;
      }

      setEbolSuccess({
        loadId: ebolLoadId,
        seq: data.block?.seq ?? nextSeq,
        blockHash: data.block?.blockHash ?? signedBlock.blockHash,
        thumbprint: keyPair.thumbprint,
        signaturePreview: signedBlock.ecdsaSignatureB64.slice(0, 36),
        queuedOffline: false,
      });
      await fetchEbolChain(ebolLoadId);
    } catch (err) {
      setEbolError(err instanceof Error ? err.message : 'Unable to generate ECDSA P-256 signature.');
    } finally {
      setEbolSigning(false);
    }
  };

  const driver = dashboard?.driver ?? null;
  const assignedLoads = dashboard?.assignedLoads ?? [];
  const stopsByLoad = dashboard?.stopsByLoad ?? {};
  const recentDocs = dashboard?.recentDocs ?? [];
  const settlements = dashboard?.settlements ?? [];
  const fleetUnits = dashboard?.fleetUnits ?? [];

  const cdlDays = computeDaysUntil(driver?.licenseExpiry ?? null);
  const medDays = computeDaysUntil(driver?.medicalCardExpiry ?? null);
  const hasUrgentCredentialAlert =
    (cdlDays !== null && cdlDays <= 30) || (medDays !== null && medDays <= 30);

  const tabs: Array<{ id: DriverTab; label: string; icon: typeof Truck; badge?: number }> = [
    { id: 'trip', label: 'Active Trip', icon: Navigation, badge: assignedLoads.length },
    { id: 'docs', label: 'Scan & Upload Docs', icon: Camera, badge: recentDocs.length },
    { id: 'dvir', label: 'DVIR Safety', icon: ClipboardCheck },
    { id: 'ebol', label: 'eBOL Sign', icon: KeyRound },
    { id: 'pay', label: 'Pay & Settlements', icon: DollarSign, badge: settlements.length },
  ];

  return (
    <div className="space-y-6">
      {/* Top Bar: Driver Status + Offline Sync Drawer */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-5 rounded-lg bg-bro-steel/70 border border-bro-gold/30 backdrop-blur-xl">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-bro-gold">
            <Truck className="w-4 h-4" />
            <span>{driver ? driver.fullName : 'Driver Command Console'}</span>
            {driver && (
              <span className="px-2 py-0.5 rounded bg-bro-obsidian/80 border border-white/10 text-bro-cyan">
                {EQUIPMENT_LABELS[driver.equipmentDivision]}
              </span>
            )}
            {driver?.fastCardNumber && (
              <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/40 text-emerald-300">
                FAST #{driver.fastCardNumber}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Offline-first commercial cab workspace · GPS EDI 214 check-ins, OCR scanning, DVIR & ECDSA eBOL.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start md:self-center">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void fetchDashboard(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/15 bg-bro-obsidian/70 hover:border-bro-cyan text-slate-200 font-mono text-[11px] uppercase cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <OfflineSyncDrawer />
        </div>
      </div>

      {/* Urgent CDL / Medical Card Expiry Alert Banner */}
      {hasUrgentCredentialAlert && (
        <div
          role="alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-amber-950/60 border border-bro-gold text-amber-100"
        >
          <div className="flex items-start gap-2.5 text-xs font-mono">
            <AlertTriangle className="w-4 h-4 text-bro-gold shrink-0 mt-0.5" />
            <div>
              <span className="font-bold uppercase text-bro-gold">Compliance Watchdog Alert: </span>
              {medDays !== null && medDays <= 30 && (
                <span>
                  DOT / NSC Medical Certificate{' '}
                  {medDays < 0 ? `expired ${Math.abs(medDays)} days ago` : `expires in ${medDays} days`} (
                  {formatDate(driver?.medicalCardExpiry ?? null)}).{' '}
                </span>
              )}
              {cdlDays !== null && cdlDays <= 30 && (
                <span>
                  Commercial Driver License{' '}
                  {cdlDays < 0 ? `expired ${Math.abs(cdlDays)} days ago` : `expires in ${cdlDays} days`} (
                  {formatDate(driver?.licenseExpiry ?? null)}).
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('docs')}
            className="px-3 py-1.5 rounded bg-bro-gold text-black font-mono text-[11px] font-bold uppercase shrink-0 cursor-pointer"
          >
            Upload Renewal Scan
          </button>
        </div>
      )}

      {loadError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-4 rounded-lg bg-rose-950/70 border border-rose-500/50 text-rose-200 font-mono text-xs"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {/* 5 Mobile-Friendly Tabs */}
      <div
        role="tablist"
        aria-label="Driver Portal Sections"
        className="flex overflow-x-auto gap-1.5 p-1.5 rounded-lg bg-bro-steel/70 border border-white/10"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-w-[140px] flex items-center justify-center gap-2 px-3 py-3 rounded font-mono text-xs font-bold uppercase tracking-wide transition-colors cursor-pointer whitespace-nowrap ${
                selected
                  ? 'bg-bro-gold text-black'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums ${
                    selected ? 'bg-black/20 text-black' : 'bg-white/10 text-slate-200'
                  }`}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="p-12 rounded-lg bg-bro-steel/50 border border-white/10 flex flex-col items-center justify-center gap-3 font-mono text-xs text-slate-400">
          <Loader2 className="w-6 h-6 text-bro-gold animate-spin" />
          <span>Synchronizing Driver Dispatch Manifest...</span>
        </div>
      ) : (
        <>
          {/* TAB 1: ACTIVE TRIP */}
          {activeTab === 'trip' && (
            <div className="space-y-5">
              {stopError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-3.5 rounded bg-rose-950/70 border border-rose-500/50 text-rose-200 font-mono text-xs"
                >
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{stopError}</span>
                </div>
              )}

              {assignedLoads.length === 0 ? (
                <div className="p-8 rounded-lg bg-bro-steel/50 border border-white/10 text-center space-y-2">
                  <Truck className="w-8 h-8 text-slate-500 mx-auto" />
                  <div className="font-mono text-xs uppercase text-slate-300">No Active Loads Assigned</div>
                  <p className="text-xs text-slate-400">
                    Dispatch will push your next commercial trip sheet here automatically.
                  </p>
                </div>
              ) : (
                assignedLoads.map((load) => {
                  const stops = [...(stopsByLoad[load.id] ?? [])].sort((a, b) => a.seq - b.seq);
                  return (
                    <section
                      key={load.id}
                      className="rounded-lg bg-bro-steel/60 border border-white/10 overflow-hidden"
                    >
                      <div className="p-4 sm:p-5 bg-bro-obsidian/70 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-white">{load.loadNumber}</span>
                            <span className="px-2 py-0.5 rounded bg-bro-cyan/15 border border-bro-cyan/40 font-mono text-[10px] font-bold uppercase text-bro-cyan">
                              {load.status.replace(/_/g, ' ')}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px] text-slate-300">
                              {DIRECTION_LABELS[load.direction]}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-bro-gold/10 border border-bro-gold/30 font-mono text-[10px] text-bro-gold">
                              {EQUIPMENT_LABELS[load.equipmentType]}
                            </span>
                          </div>
                          <div className="text-sm text-slate-200 font-medium">{load.commodity}</div>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
                          <div className="px-2.5 py-1.5 rounded bg-bro-steel/80 border border-white/10 text-slate-300">
                            {load.weightLbs.toLocaleString()} lbs · {load.loadedMiles} mi
                          </div>
                          {load.tempSetpointC !== null && (
                            <div className="px-2.5 py-1.5 rounded bg-cyan-950/60 border border-bro-cyan/40 text-bro-cyan font-bold">
                              Setpoint {load.tempSetpointC.toFixed(1)}°C
                            </div>
                          )}
                          {load.detentionMinutes > 0 && (
                            <div className="px-2.5 py-1.5 rounded bg-amber-950/60 border border-bro-gold/50 text-bro-gold">
                              Detention: {load.detentionMinutes} min
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="p-4 sm:p-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-400">
                            Itinerary & 1-Tap GPS Check-In (Auto EDI 214)
                          </h3>
                          <a
                            href={`/verify/${encodeURIComponent(load.id)}`}
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-bro-cyan hover:underline"
                          >
                            <span>View eBOL Chain</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>

                        {stops.length === 0 ? (
                          <p className="font-mono text-xs text-slate-400">No stops recorded on this dispatch yet.</p>
                        ) : (
                          <div className="space-y-3">
                            {stops.map((stop) => {
                              const fb = stopFeedback[stop.id];
                              const busyArrive = checkingInKey === `${stop.id}:arrived`;
                              const busyDepart = checkingInKey === `${stop.id}:departed`;
                              return (
                                <div
                                  key={stop.id}
                                  className="p-4 rounded-lg bg-bro-obsidian/80 border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                                >
                                  <div className="space-y-1.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="px-2 py-0.5 rounded bg-white/10 font-mono text-[10px] font-bold uppercase text-white">
                                        STOP {stop.seq} · {stop.stopType.replace(/_/g, ' ')}
                                      </span>
                                      {stop.arrivedAt && (
                                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-[10px] text-emerald-300">
                                          Arrived {formatDateTime(stop.arrivedAt)}
                                        </span>
                                      )}
                                      {stop.departedAt && (
                                        <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-bro-cyan/30 font-mono text-[10px] text-bro-cyan">
                                          Departed {formatDateTime(stop.departedAt)}
                                        </span>
                                      )}
                                    </div>
                                    <div className="font-display font-bold text-sm text-white">
                                      {stop.facilityName}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                                      <span className="inline-flex items-center gap-1">
                                        <MapPin className="w-3.5 h-3.5 text-bro-gold" />
                                        {stop.address}
                                      </span>
                                      <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                                        <Clock className="w-3.5 h-3.5 text-slate-500" />
                                        Appt: {formatDateTime(stop.apptStart)} – {formatDateTime(stop.apptEnd)}
                                      </span>
                                    </div>

                                    {fb && (
                                      <div className="pt-1 flex flex-wrap items-center gap-2">
                                        {fb.queuedOffline ? (
                                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-950/70 border border-bro-gold text-bro-gold font-mono text-[10px] font-bold uppercase">
                                            <WifiOff className="w-3 h-3" />
                                            <span>
                                              {fb.event.toUpperCase()} Queued Offline — Will Transmit EDI 214 on Signal
                                            </span>
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-950/70 border border-emerald-400/50 text-emerald-300 font-mono text-[10px] font-bold uppercase">
                                            <Radio className="w-3 h-3" />
                                            <span>
                                              {fb.edi214Issued ? 'EDI 214 Confirmed' : 'Check-In Confirmed'} · Status:{' '}
                                              {(fb.loadStatus ?? load.status).replace(/_/g, ' ')}
                                            </span>
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-2.5 shrink-0">
                                    <button
                                      type="button"
                                      disabled={busyArrive || Boolean(stop.arrivedAt)}
                                      onClick={() => void handleStopCheckin(load, stop, 'arrived')}
                                      className="flex-1 lg:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded bg-bro-gold hover:bg-amber-400 text-black font-mono text-xs font-bold uppercase disabled:opacity-40 transition-colors cursor-pointer"
                                    >
                                      {busyArrive ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <MapPin className="w-3.5 h-3.5" />
                                      )}
                                      <span>{stop.arrivedAt ? 'Arrived ✓' : 'Arrived'}</span>
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busyDepart || Boolean(stop.departedAt)}
                                      onClick={() => void handleStopCheckin(load, stop, 'departed')}
                                      className="flex-1 lg:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded bg-bro-cyan hover:bg-cyan-300 text-black font-mono text-xs font-bold uppercase disabled:opacity-40 transition-colors cursor-pointer"
                                    >
                                      {busyDepart ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <Navigation className="w-3.5 h-3.5" />
                                      )}
                                      <span>{stop.departedAt ? 'Departed ✓' : 'Departed'}</span>
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 2: SCAN & UPLOAD DOCS */}
          {activeTab === 'docs' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-6">
                <MobileDocScanner
                  loads={assignedLoads}
                  defaultLoadId={assignedLoads[0]?.id ?? ''}
                  onUploaded={() => void fetchDashboard(true)}
                />
              </div>

              <div className="lg:col-span-6 rounded-lg bg-bro-steel/60 border border-white/10 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-bro-gold" />
                    <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                      Uploaded Documents & Live OCR Pipeline ({recentDocs.length})
                    </h3>
                  </div>
                </div>

                {recentDocs.length === 0 ? (
                  <div className="p-8 rounded bg-bro-obsidian/60 border border-white/10 text-center font-mono text-xs text-slate-400">
                    No driver scans uploaded yet. Capture a BOL, POD, fuel receipt, or credential scan on the left.
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
                    {recentDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="p-3.5 rounded-lg bg-bro-obsidian/80 border border-white/10 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-white/10 font-mono text-[10px] font-bold uppercase text-white">
                              {doc.docType}
                            </span>
                            <span className="font-mono text-xs text-slate-200 truncate max-w-[200px]">
                              {doc.originalFilename}
                            </span>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold uppercase ${ocrStatusBadgeStyle(doc.ocrStatus)}`}
                          >
                            {doc.ocrStatus.replace(/_/g, ' ')}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-400 tabular-nums">
                          <span>
                            {(doc.sizeBytes / 1024).toFixed(1)} KB · SHA-256: {doc.sha256Hex.slice(0, 14)}…
                          </span>
                          <span>
                            {doc.ocrConfidence !== null
                              ? `OCR ${(doc.ocrConfidence * 100).toFixed(0)}% · `
                              : ''}
                            {formatDateTime(doc.createdAt)}
                          </span>
                        </div>

                        {doc.reviewNotes && (
                          <div className="p-2 rounded bg-bro-steel/70 border border-white/10 text-[11px] font-mono text-slate-300">
                            Reviewer: {doc.reviewNotes}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: DVIR SAFETY */}
          {activeTab === 'dvir' && (
            <DvirInspectionForm
              fleetUnits={fleetUnits}
              defaultTractorId={assignedLoads[0]?.tractorId ?? undefined}
              defaultTrailerId={assignedLoads[0]?.trailerId ?? undefined}
              defaultDriverName={driver?.fullName ?? ''}
              onSubmitted={() => void fetchDashboard(true)}
            />
          )}

          {/* TAB 4: eBOL CRYPTOGRAPHIC SIGNING */}
          {activeTab === 'ebol' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <form
                onSubmit={handleSignEbolPickup}
                className="lg:col-span-7 rounded-lg bg-bro-steel/60 border border-white/10 p-5 sm:p-6 space-y-5"
              >
                <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-bro-cyan" />
                    <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                      ECDSA P-256 eBOL Carrier Pickup Signature
                    </h3>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-bro-cyan/10 border border-bro-cyan/30 font-mono text-[10px] text-bro-cyan">
                    STAGE: CARRIER_PICKUP
                  </span>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  Generates a hardware-backed browser Web Crypto <code className="text-bro-cyan">ECDSA P-256</code> key
                  pair, hashes the canonical custody payload with <code className="text-bro-cyan">SHA-256</code>, chains
                  onto the load&apos;s previous block hash, and submits a verifiable custody block to{' '}
                  <code className="text-bro-cyan">/api/ebol/:loadId/sign</code>.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="ebol-load" className="block font-mono text-[11px] uppercase text-slate-300">
                      Assigned Load *
                    </label>
                    <select
                      id="ebol-load"
                      required
                      value={ebolLoadId}
                      onChange={(e) => setEbolLoadId(e.target.value)}
                      className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm text-white outline-none focus:border-bro-cyan"
                    >
                      <option value="">Select assigned load...</option>
                      {assignedLoads.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.loadNumber} — {l.commodity.slice(0, 32)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="ebol-signer" className="block font-mono text-[11px] uppercase text-slate-300">
                      Driver Signer Name *
                    </label>
                    <input
                      id="ebol-signer"
                      type="text"
                      required
                      minLength={2}
                      value={ebolSignerName}
                      onChange={(e) => setEbolSignerName(e.target.value)}
                      placeholder="e.g. Liam Gallant"
                      className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm text-white outline-none focus:border-bro-cyan"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="ebol-seal" className="block font-mono text-[11px] uppercase text-slate-300">
                      Trailer Seal Number
                    </label>
                    <input
                      id="ebol-seal"
                      type="text"
                      value={ebolSealNumber}
                      onChange={(e) => setEbolSealNumber(e.target.value.toUpperCase())}
                      placeholder="e.g. SEAL-BROP-44291"
                      className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm font-mono text-white outline-none focus:border-bro-cyan"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="ebol-pieces" className="block font-mono text-[11px] uppercase text-slate-300">
                      Pieces / Pallets Counted
                    </label>
                    <input
                      id="ebol-pieces"
                      type="number"
                      min={1}
                      max={9999}
                      value={ebolPieces}
                      onChange={(e) => setEbolPieces(e.target.value)}
                      className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm font-mono text-white outline-none focus:border-bro-cyan tabular-nums"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ebol-notes" className="block font-mono text-[11px] uppercase text-slate-300">
                    Pickup Custody & Condition Notes
                  </label>
                  <textarea
                    id="ebol-notes"
                    rows={2}
                    value={ebolNotes}
                    onChange={(e) => setEbolNotes(e.target.value)}
                    className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2 text-sm text-white outline-none focus:border-bro-cyan"
                  />
                </div>

                {ebolError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 p-3.5 rounded bg-rose-950/70 border border-rose-500/50 text-rose-200 font-mono text-xs"
                  >
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span>{ebolError}</span>
                  </div>
                )}

                {ebolSuccess && (
                  <div
                    role="status"
                    aria-live="polite"
                    className={`p-4 rounded border space-y-2 font-mono text-xs ${
                      ebolSuccess.queuedOffline
                        ? 'bg-amber-950/60 border-bro-gold text-amber-100'
                        : 'bg-emerald-950/60 border-emerald-500/50 text-emerald-100'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold uppercase">
                      {ebolSuccess.queuedOffline ? (
                        <>
                          <WifiOff className="w-4 h-4 text-bro-gold" />
                          <span>ECDSA Pickup Signature Queued Offline</span>
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="w-4 h-4 text-emerald-400" />
                          <span>Block #{ebolSuccess.seq} Verified & Appended to eBOL Ledger</span>
                        </>
                      )}
                    </div>
                    <div className="text-[11px] break-all space-y-1 text-slate-200">
                      <div>Block SHA-256: {ebolSuccess.blockHash}</div>
                      <div>Key Thumbprint: {ebolSuccess.thumbprint}</div>
                      <div>ECDSA Sig: {ebolSuccess.signaturePreview}…</div>
                    </div>
                    <div className="pt-2 flex flex-wrap gap-2">
                      <a
                        href={`/verify/${encodeURIComponent(ebolSuccess.loadId)}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-cyan text-black font-bold uppercase text-[11px]"
                      >
                        <span>Open Public eBOL Verifier</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      {!ebolSuccess.queuedOffline && (
                        <a
                          href={`/api/ebol/${encodeURIComponent(ebolSuccess.loadId)}/certificate.pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/20 text-white hover:border-bro-gold text-[11px]"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Certificate PDF</span>
                        </a>
                      )}
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={ebolSigning || !ebolLoadId}
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded bg-bro-cyan hover:bg-cyan-300 text-black font-mono text-xs font-bold uppercase tracking-wider disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {ebolSigning ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Signing ECDSA P-256 Custody Block...</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4" />
                      <span>Sign CARRIER_PICKUP Block (ECDSA P-256)</span>
                    </>
                  )}
                </button>
              </form>

              {/* Current Chain Inspector */}
              <div className="lg:col-span-5 rounded-lg bg-bro-steel/60 border border-white/10 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <span className="font-mono text-xs font-bold uppercase text-white">
                    Custody Chain ({ebolChain.length} Blocks)
                  </span>
                  {ebolLoadId && (
                    <a
                      href={`/verify/${encodeURIComponent(ebolLoadId)}`}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-bro-cyan hover:underline"
                    >
                      <span>/verify/{ebolLoadId}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>

                {ebolChainLoading ? (
                  <div className="py-8 flex items-center justify-center gap-2 font-mono text-xs text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Reading custody blocks...</span>
                  </div>
                ) : ebolChain.length === 0 ? (
                  <div className="p-6 rounded bg-bro-obsidian/60 border border-white/10 font-mono text-xs text-slate-400">
                    No blocks signed yet for this load. Signing CARRIER_PICKUP will anchor Block #1 to the deterministic
                    load genesis hash.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {ebolChain.map((blk) => (
                      <div
                        key={blk.id}
                        className="p-3.5 rounded bg-bro-obsidian/80 border border-emerald-500/30 space-y-1.5 font-mono text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-emerald-300 font-bold">
                            #{blk.seq} · {blk.stage}
                          </span>
                          <span className="text-[10px] text-slate-400">{formatDateTime(blk.signedAt)}</span>
                        </div>
                        <div className="text-white text-xs">
                          {blk.actorName} ({blk.actorRole})
                        </div>
                        <div className="text-[10px] text-slate-400 break-all">
                          Hash: {blk.blockHash.slice(0, 28)}…
                        </div>
                        <div className="text-[10px] text-slate-500 tabular-nums">
                          GPS: {blk.gpsLat.toFixed(4)}, {blk.gpsLon.toFixed(4)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: PAY & SETTLEMENTS + CDL/MEDICAL EXPIRY ALERTS */}
          {activeTab === 'pay' && (
            <div className="space-y-6">
              {/* Compliance Credentials & Pay Model Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div
                  className={`p-4 rounded-lg border space-y-1.5 ${
                    cdlDays !== null && cdlDays <= 30
                      ? 'bg-rose-950/50 border-rose-500/60'
                      : 'bg-bro-steel/60 border-white/10'
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase text-slate-400">
                    <span>Commercial Driver License</span>
                    <span
                      className={`font-bold ${
                        cdlDays === null
                          ? 'text-slate-400'
                          : cdlDays <= 30
                            ? 'text-rose-300'
                            : cdlDays <= 60
                              ? 'text-bro-gold'
                              : 'text-emerald-400'
                      }`}
                    >
                      {cdlDays === null
                        ? 'UNVERIFIED'
                        : cdlDays < 0
                          ? `EXPIRED (${Math.abs(cdlDays)}d)`
                          : `${cdlDays} DAYS LEFT`}
                    </span>
                  </div>
                  <div className="font-mono text-sm font-bold text-white">
                    {driver?.licenseClass || 'Class 1 / AZ'} · {driver?.licenseNumber || 'On file'}
                  </div>
                  <div className="font-mono text-[11px] text-slate-300">
                    Expires: {formatDate(driver?.licenseExpiry ?? null)}
                  </div>
                </div>

                <div
                  className={`p-4 rounded-lg border space-y-1.5 ${
                    medDays !== null && medDays <= 30
                      ? 'bg-amber-950/60 border-bro-gold'
                      : 'bg-bro-steel/60 border-white/10'
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase text-slate-400">
                    <span>DOT / NSC Medical Card</span>
                    <span
                      className={`font-bold ${
                        medDays === null
                          ? 'text-slate-400'
                          : medDays < 0
                            ? 'text-rose-300'
                            : medDays <= 30
                              ? 'text-bro-gold'
                              : 'text-emerald-400'
                      }`}
                    >
                      {medDays === null
                        ? 'UNVERIFIED'
                        : medDays < 0
                          ? `EXPIRED (${Math.abs(medDays)}d)`
                          : `${medDays} DAYS LEFT`}
                    </span>
                  </div>
                  <div className="font-mono text-sm font-bold text-white">
                    {medDays !== null && medDays <= 30 ? 'Renewal Action Required' : 'Medical Cleared'}
                  </div>
                  <div className="font-mono text-[11px] text-slate-300">
                    Expires: {formatDate(driver?.medicalCardExpiry ?? null)}
                  </div>
                </div>

                <div className="p-4 rounded-lg bg-bro-steel/60 border border-white/10 space-y-1.5">
                  <div className="font-mono text-[10px] uppercase text-slate-400">Active Pay Structure</div>
                  <div className="font-mono text-sm font-bold text-bro-cyan tabular-nums">
                    {driver
                      ? driver.payModel === 'cpm'
                        ? `$${(driver.payRateValue / 100).toFixed(2)} / loaded mile (CPM)`
                        : `${(driver.payRateValue / 100).toFixed(2)}% of Load Gross`
                      : '—'}
                  </div>
                  <div className="font-mono text-[11px] text-slate-400">
                    Direct deposit · Settlement PDF archived to Vault
                  </div>
                </div>
              </div>

              {/* Settlements Table */}
              <div className="rounded-lg bg-bro-steel/60 border border-white/10 overflow-hidden">
                <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-white">
                    <DollarSign className="w-4 h-4 text-bro-gold" />
                    <span>Driver Settlement Statements ({settlements.length})</span>
                  </div>
                </div>

                {settlements.length === 0 ? (
                  <div className="p-8 text-center font-mono text-xs text-slate-400">
                    No finalized driver settlements yet. Completed loads will appear on your bi-weekly pay statement.
                  </div>
                ) : (
                  <div className="divide-y divide-white/10">
                    {settlements.map((s) => (
                      <div
                        key={s.id}
                        className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-white/[0.02]"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-white">{s.settlementNumber}</span>
                            <span
                              className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${
                                s.status === 'paid'
                                  ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                                  : s.status === 'finalized'
                                    ? 'bg-cyan-500/20 border-bro-cyan/50 text-bro-cyan'
                                    : 'bg-slate-800 border-white/15 text-slate-300'
                              }`}
                            >
                              {s.status}
                            </span>
                          </div>
                          <div className="font-mono text-xs text-slate-400">
                            Period: {formatDate(s.periodStart)} – {formatDate(s.periodEnd)}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs tabular-nums">
                          <div>
                            <div className="text-[10px] text-slate-400 uppercase">Gross</div>
                            <div className="text-slate-200">{formatMoneyCents(s.grossPayCents, s.currency)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 uppercase">Reimb.</div>
                            <div className="text-emerald-300">
                              +{formatMoneyCents(s.reimbursementsCents, s.currency)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 uppercase">Deduct.</div>
                            <div className="text-rose-300">
                              -{formatMoneyCents(s.deductionsCents, s.currency)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 uppercase">Net Pay</div>
                            <div className="text-bro-gold font-bold">{formatMoneyCents(s.netPayCents, s.currency)}</div>
                          </div>
                        </div>

                        <a
                          href={`/api/settlements/${encodeURIComponent(s.id)}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded border border-bro-cyan/40 bg-bro-cyan/10 hover:bg-bro-cyan hover:text-black text-bro-cyan font-mono text-xs font-bold uppercase transition-colors shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download PDF</span>
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
