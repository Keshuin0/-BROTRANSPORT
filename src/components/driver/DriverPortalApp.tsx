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

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, currentId: DriverTab) => {
    const idx = tabs.findIndex((t) => t.id === currentId);
    if (idx === -1) return;

    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabs.length - 1;

    if (nextIdx !== null) {
      e.preventDefault();
      const targetTab = tabs[nextIdx];
      setActiveTab(targetTab.id);
      document.getElementById(`driver-tab-${targetTab.id}`)?.focus();
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Bar: Driver Status + Offline Sync Drawer */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-5 sm:p-6 rounded-2xl surface-ceramic border-bro-gold/25">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-bro-gold/15 border border-bro-gold/40 text-bro-gold font-semibold">
              <Truck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{driver ? driver.fullName : 'Driver Command Console'}</span>
            </span>
            {driver && (
              <span className="px-3 py-1 rounded-full bg-[#060912] border border-white/15 text-bro-cyan font-medium">
                {EQUIPMENT_LABELS[driver.equipmentDivision]}
              </span>
            )}
            {driver?.fastCardNumber && (
              <span className="px-3 py-1 rounded-full bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 font-medium">
                FAST #{driver.fastCardNumber}
              </span>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
            Driver Command &amp; Cab Workspace
          </h1>
          <p className="text-xs sm:text-sm text-slate-300">
            Offline-first commercial cab workspace · GPS EDI 214 check-ins, OCR scanning, DVIR &amp; ECDSA eBOL.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-center shrink-0">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void fetchDashboard(true)}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-[#060912] hover:border-bro-cyan text-slate-200 text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <OfflineSyncDrawer />
        </div>
      </div>

      {/* Urgent CDL / Medical Card Expiry Alert Banner */}
      {hasUrgentCredentialAlert && (
        <div
          role="alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-amber-950/60 border border-bro-gold text-amber-100"
        >
          <div className="flex items-start gap-2.5 text-xs sm:text-sm">
            <AlertTriangle className="w-4 h-4 text-bro-gold shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <span className="font-semibold text-bro-gold">Compliance Watchdog Alert: </span>
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
            className="min-h-[44px] px-4 py-2 rounded-full bg-bro-gold hover:bg-amber-300 text-black text-xs font-semibold shrink-0 cursor-pointer transition-colors"
          >
            Upload Renewal Scan
          </button>
        </div>
      )}

      {loadError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-4 rounded-2xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{loadError}</span>
        </div>
      )}

      {/* 5 Mobile-Friendly Wrapping Tabs */}
      <div
        role="tablist"
        aria-label="Driver Portal Sections"
        className="flex flex-wrap sm:inline-flex items-center gap-1.5 p-1.5 rounded-2xl sm:rounded-full surface-ceramic w-full sm:w-auto"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`driver-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`driver-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, tab.id)}
              className={`flex-1 sm:flex-initial min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                selected
                  ? 'bg-bro-gold text-black shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span
                  className={`px-2 py-0.5 rounded-full text-xs tabular-nums ${
                    selected ? 'bg-black/15 text-black' : 'bg-white/10 text-slate-200'
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
        <div className="p-12 rounded-2xl surface-ceramic flex flex-col items-center justify-center gap-3 text-xs text-slate-300">
          <Loader2 className="w-6 h-6 text-bro-gold animate-spin" aria-hidden="true" />
          <span>Synchronizing Driver Dispatch Manifest...</span>
        </div>
      ) : (
        <>
          {/* TAB 1: ACTIVE TRIP */}
          {activeTab === 'trip' && (
            <div
              role="tabpanel"
              id="driver-panel-trip"
              aria-labelledby="driver-tab-trip"
              tabIndex={0}
              className="space-y-5 outline-none"
            >
              {stopError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-3.5 rounded-xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium"
                >
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{stopError}</span>
                </div>
              )}

              {assignedLoads.length === 0 ? (
                <div className="p-8 rounded-2xl surface-ceramic text-center space-y-2.5">
                  <Truck className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
                  <div className="font-display text-base font-semibold text-white">No Active Loads Assigned</div>
                  <p className="text-xs sm:text-sm text-slate-300">
                    Dispatch will push your next commercial trip sheet here automatically.
                  </p>
                </div>
              ) : (
                assignedLoads.map((load) => {
                  const stops = [...(stopsByLoad[load.id] ?? [])].sort((a, b) => a.seq - b.seq);
                  return (
                    <section
                      key={load.id}
                      className="rounded-2xl surface-ceramic overflow-hidden"
                    >
                      <div className="p-5 bg-[#060912] border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-base font-bold text-white">{load.loadNumber}</span>
                            <span className="px-2.5 py-0.5 rounded-full bg-bro-cyan/15 border border-bro-cyan/40 text-xs font-semibold text-bro-cyan uppercase">
                              {load.status.replace(/_/g, ' ')}
                            </span>
                            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/15 text-xs text-slate-200">
                              {DIRECTION_LABELS[load.direction]}
                            </span>
                            <span className="px-2.5 py-0.5 rounded-full bg-bro-gold/15 border border-bro-gold/35 text-xs font-medium text-bro-gold">
                              {EQUIPMENT_LABELS[load.equipmentType]}
                            </span>
                          </div>
                          <div className="text-sm text-slate-200 font-medium">{load.commodity}</div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2.5 font-mono text-xs tabular-nums">
                          <div className="px-3 py-1.5 rounded-full bg-[#0b1120] border border-white/15 text-slate-200">
                            {load.weightLbs.toLocaleString()} lbs · {load.loadedMiles} mi
                          </div>
                          {load.tempSetpointC !== null && (
                            <div className="px-3 py-1.5 rounded-full bg-cyan-950/60 border border-bro-cyan/40 text-bro-cyan font-semibold">
                              Setpoint {load.tempSetpointC.toFixed(1)}°C
                            </div>
                          )}
                          {load.detentionMinutes > 0 && (
                            <div className="px-3 py-1.5 rounded-full bg-amber-950/60 border border-bro-gold/50 text-bro-gold font-semibold">
                              Detention: {load.detentionMinutes} min
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="p-5 space-y-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h2 className="font-display text-sm font-semibold text-slate-200">
                            Itinerary &amp; 1-Tap GPS Check-In (Auto EDI 214)
                          </h2>
                          <a
                            href={`/verify/${encodeURIComponent(load.id)}`}
                            className="min-h-[44px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-bro-cyan hover:underline"
                          >
                            <span>View eBOL Chain</span>
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          </a>
                        </div>

                        {stops.length === 0 ? (
                          <p className="text-xs text-slate-300">No stops recorded on this dispatch yet.</p>
                        ) : (
                          <div className="space-y-3">
                            {stops.map((stop) => {
                              const fb = stopFeedback[stop.id];
                              const busyArrive = checkingInKey === `${stop.id}:arrived`;
                              const busyDepart = checkingInKey === `${stop.id}:departed`;
                              return (
                                <div
                                  key={stop.id}
                                  className="p-4 sm:p-5 rounded-2xl bg-[#060912] border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                                >
                                  <div className="space-y-1.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-xs font-semibold uppercase text-white">
                                        STOP {stop.seq} · {stop.stopType.replace(/_/g, ' ')}
                                      </span>
                                      {stop.arrivedAt && (
                                        <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/35 text-xs text-emerald-300">
                                          Arrived {formatDateTime(stop.arrivedAt)}
                                        </span>
                                      )}
                                      {stop.departedAt && (
                                        <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/15 border border-bro-cyan/35 text-xs text-bro-cyan">
                                          Departed {formatDateTime(stop.departedAt)}
                                        </span>
                                      )}
                                    </div>
                                    <div className="font-display font-bold text-base text-white">
                                      {stop.facilityName}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
                                      <span className="inline-flex items-center gap-1.5">
                                        <MapPin className="w-3.5 h-3.5 text-bro-gold shrink-0" aria-hidden="true" />
                                        <span>{stop.address}</span>
                                      </span>
                                      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-300">
                                        <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                                        <span>
                                          Appt: {formatDateTime(stop.apptStart)} – {formatDateTime(stop.apptEnd)}
                                        </span>
                                      </span>
                                    </div>

                                    {fb && (
                                      <div className="pt-1 flex flex-wrap items-center gap-2">
                                        {fb.queuedOffline ? (
                                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-950/70 border border-bro-gold text-bro-gold text-xs font-semibold">
                                            <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                            <span>
                                              {fb.event.toUpperCase()} Queued Offline — Will Transmit EDI 214 on Signal
                                            </span>
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/70 border border-emerald-400/50 text-emerald-300 text-xs font-semibold">
                                            <Radio className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
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
                                      className="flex-1 lg:flex-none min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-bro-gold hover:bg-amber-300 text-black text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer"
                                    >
                                      {busyArrive ? (
                                        <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                                      ) : (
                                        <MapPin className="w-4 h-4 shrink-0" aria-hidden="true" />
                                      )}
                                      <span>{stop.arrivedAt ? 'Arrived ✓' : 'Arrived'}</span>
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busyDepart || Boolean(stop.departedAt)}
                                      onClick={() => void handleStopCheckin(load, stop, 'departed')}
                                      className="flex-1 lg:flex-none min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer"
                                    >
                                      {busyDepart ? (
                                        <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                                      ) : (
                                        <Navigation className="w-4 h-4 shrink-0" aria-hidden="true" />
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
            <div
              role="tabpanel"
              id="driver-panel-docs"
              aria-labelledby="driver-tab-docs"
              tabIndex={0}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6 outline-none"
            >
              <div className="lg:col-span-6">
                <MobileDocScanner
                  loads={assignedLoads}
                  defaultLoadId={assignedLoads[0]?.id ?? ''}
                  onUploaded={() => void fetchDashboard(true)}
                />
              </div>

              <div className="lg:col-span-6 rounded-2xl surface-ceramic p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
                  <div className="flex items-center gap-2.5">
                    <FileText className="w-5 h-5 text-bro-gold shrink-0" aria-hidden="true" />
                    <h2 className="font-display text-base font-bold text-white tracking-tight">
                      Uploaded Documents &amp; Live OCR Pipeline ({recentDocs.length})
                    </h2>
                  </div>
                </div>

                {recentDocs.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-[#060912] border border-white/10 text-center text-xs text-slate-300 leading-relaxed">
                    No driver scans uploaded yet. Capture a BOL, POD, fuel receipt, or credential scan on the left.
                  </div>
                ) : (
                  <div className="space-y-3 max-h-[540px] overflow-y-auto pr-1">
                    {recentDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="p-4 rounded-2xl bg-[#060912] border border-white/10 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-xs font-semibold uppercase text-white shrink-0">
                              {doc.docType}
                            </span>
                            <span className="font-mono text-xs text-slate-200 truncate max-w-[200px]">
                              {doc.originalFilename}
                            </span>
                          </div>
                          <span
                            className={`px-2.5 py-0.5 rounded-full border text-xs font-semibold uppercase ${ocrStatusBadgeStyle(doc.ocrStatus)}`}
                          >
                            {doc.ocrStatus.replace(/_/g, ' ')}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-slate-300 tabular-nums">
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
                          <div className="p-2.5 rounded-xl bg-[#0b1120] border border-white/10 text-xs text-slate-200">
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
            <div
              role="tabpanel"
              id="driver-panel-dvir"
              aria-labelledby="driver-tab-dvir"
              tabIndex={0}
              className="outline-none"
            >
              <DvirInspectionForm
                fleetUnits={fleetUnits}
                defaultTractorId={assignedLoads[0]?.tractorId ?? undefined}
                defaultTrailerId={assignedLoads[0]?.trailerId ?? undefined}
                defaultDriverName={driver?.fullName ?? ''}
                onSubmitted={() => void fetchDashboard(true)}
              />
            </div>
          )}

          {/* TAB 4: eBOL CRYPTOGRAPHIC SIGNING */}
          {activeTab === 'ebol' && (
            <div
              role="tabpanel"
              id="driver-panel-ebol"
              aria-labelledby="driver-tab-ebol"
              tabIndex={0}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6 outline-none"
            >
              <form
                onSubmit={handleSignEbolPickup}
                className="lg:col-span-7 rounded-2xl surface-ceramic p-5 sm:p-6 space-y-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3.5">
                  <div className="flex items-center gap-2.5">
                    <KeyRound className="w-5 h-5 text-bro-cyan shrink-0" aria-hidden="true" />
                    <h2 className="font-display text-base font-bold text-white tracking-tight">
                      ECDSA P-256 eBOL Carrier Pickup Signature
                    </h2>
                  </div>
                  <span className="px-3 py-1 rounded-full bg-bro-cyan/15 border border-bro-cyan/35 font-mono text-xs font-medium text-bro-cyan">
                    STAGE: CARRIER_PICKUP
                  </span>
                </div>

                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  Generates a hardware-backed browser Web Crypto <code className="text-bro-cyan">ECDSA P-256</code> key
                  pair, hashes the canonical custody payload with <code className="text-bro-cyan">SHA-256</code>, chains
                  onto the load&apos;s previous block hash, and submits a verifiable custody block to{' '}
                  <code className="text-bro-cyan">/api/ebol/:loadId/sign</code>.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="ebol-load" className="block text-xs font-medium text-slate-300">
                      Assigned Load *
                    </label>
                    <select
                      id="ebol-load"
                      required
                      value={ebolLoadId}
                      onChange={(e) => setEbolLoadId(e.target.value)}
                      className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none focus:border-bro-cyan"
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
                    <label htmlFor="ebol-signer" className="block text-xs font-medium text-slate-300">
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
                      className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="ebol-seal" className="block text-xs font-medium text-slate-300">
                      Trailer Seal Number
                    </label>
                    <input
                      id="ebol-seal"
                      type="text"
                      value={ebolSealNumber}
                      onChange={(e) => setEbolSealNumber(e.target.value.toUpperCase())}
                      placeholder="e.g. SEAL-BROP-44291"
                      className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="ebol-pieces" className="block text-xs font-medium text-slate-300">
                      Pieces / Pallets Counted
                    </label>
                    <input
                      id="ebol-pieces"
                      type="number"
                      min={1}
                      max={9999}
                      value={ebolPieces}
                      onChange={(e) => setEbolPieces(e.target.value)}
                      className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white outline-none focus:border-bro-cyan tabular-nums"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ebol-notes" className="block text-xs font-medium text-slate-300">
                    Pickup Custody &amp; Condition Notes
                  </label>
                  <textarea
                    id="ebol-notes"
                    rows={2}
                    value={ebolNotes}
                    onChange={(e) => setEbolNotes(e.target.value)}
                    className="w-full min-h-[72px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none focus:border-bro-cyan"
                  />
                </div>

                {ebolError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 p-3.5 rounded-xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium"
                  >
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{ebolError}</span>
                  </div>
                )}

                {ebolSuccess && (
                  <div
                    role="status"
                    aria-live="polite"
                    className={`p-4 rounded-2xl border space-y-2 text-xs ${
                      ebolSuccess.queuedOffline
                        ? 'bg-amber-950/60 border-bro-gold text-amber-100'
                        : 'bg-emerald-950/60 border-emerald-500/50 text-emerald-100'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {ebolSuccess.queuedOffline ? (
                        <>
                          <WifiOff className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
                          <span>ECDSA Pickup Signature Queued Offline</span>
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                          <span>Block #{ebolSuccess.seq} Verified &amp; Appended to eBOL Ledger</span>
                        </>
                      )}
                    </div>
                    <div className="font-mono text-xs break-all space-y-1 text-slate-200">
                      <div>Block SHA-256: {ebolSuccess.blockHash}</div>
                      <div>Key Thumbprint: {ebolSuccess.thumbprint}</div>
                      <div>ECDSA Sig: {ebolSuccess.signaturePreview}…</div>
                    </div>
                    <div className="pt-2 flex flex-wrap gap-2.5">
                      <a
                        href={`/verify/${encodeURIComponent(ebolSuccess.loadId)}`}
                        className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full bg-bro-cyan hover:bg-cyan-300 text-black font-semibold text-xs transition-colors"
                      >
                        <span>Open Public eBOL Verifier</span>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </a>
                      {!ebolSuccess.queuedOffline && (
                        <a
                          href={`/api/ebol/${encodeURIComponent(ebolSuccess.loadId)}/certificate.pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/20 bg-[#060912] text-white hover:border-bro-gold font-semibold text-xs transition-colors"
                        >
                          <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span>Certificate PDF</span>
                        </a>
                      )}
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={ebolSigning || !ebolLoadId}
                  className="w-full min-h-[48px] flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black text-sm font-semibold disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {ebolSigning ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                      <span>Signing ECDSA P-256 Custody Block...</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>Sign CARRIER_PICKUP Block (ECDSA P-256)</span>
                    </>
                  )}
                </button>
              </form>

              {/* Current Chain Inspector */}
              <div className="lg:col-span-5 rounded-2xl surface-ceramic p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3.5">
                  <h2 className="font-display text-base font-bold text-white tracking-tight">
                    Custody Chain ({ebolChain.length} Blocks)
                  </h2>
                  {ebolLoadId && (
                    <a
                      href={`/verify/${encodeURIComponent(ebolLoadId)}`}
                      className="min-h-[44px] inline-flex items-center gap-1.5 font-mono text-xs text-bro-cyan hover:underline"
                    >
                      <span>/verify/{ebolLoadId}</span>
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    </a>
                  )}
                </div>

                {ebolChainLoading ? (
                  <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-300">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Reading custody blocks...</span>
                  </div>
                ) : ebolChain.length === 0 ? (
                  <div className="p-6 rounded-2xl bg-[#060912] border border-white/10 text-xs text-slate-300 leading-relaxed">
                    No blocks signed yet for this load. Signing CARRIER_PICKUP will anchor Block #1 to the deterministic
                    load genesis hash.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {ebolChain.map((blk) => (
                      <div
                        key={blk.id}
                        className="p-4 rounded-2xl bg-[#060912] border border-emerald-500/35 space-y-1.5 font-mono text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-emerald-300 font-bold">
                            #{blk.seq} · {blk.stage}
                          </span>
                          <span className="text-xs text-slate-300">{formatDateTime(blk.signedAt)}</span>
                        </div>
                        <div className="font-sans text-white text-sm font-medium">
                          {blk.actorName} ({blk.actorRole})
                        </div>
                        <div className="text-xs text-slate-300 break-all">
                          Hash: {blk.blockHash.slice(0, 28)}…
                        </div>
                        <div className="text-xs text-slate-400 tabular-nums">
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
            <div
              role="tabpanel"
              id="driver-panel-pay"
              aria-labelledby="driver-tab-pay"
              tabIndex={0}
              className="space-y-6 outline-none"
            >
              {/* Compliance Credentials & Pay Model Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div
                  className={`p-5 rounded-2xl border space-y-2 ${
                    cdlDays !== null && cdlDays <= 30
                      ? 'bg-rose-950/50 border-rose-500/60'
                      : 'surface-ceramic'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-medium">Commercial Driver License</span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full font-semibold ${
                        cdlDays === null
                          ? 'bg-white/10 text-slate-300'
                          : cdlDays <= 30
                            ? 'bg-rose-950 text-rose-200 border border-rose-500/40'
                            : cdlDays <= 60
                              ? 'bg-amber-950 text-bro-gold border border-bro-gold/40'
                              : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      }`}
                    >
                      {cdlDays === null
                        ? 'Unverified'
                        : cdlDays < 0
                          ? `Expired (${Math.abs(cdlDays)}d)`
                          : `${cdlDays} days left`}
                    </span>
                  </div>
                  <div className="font-mono text-sm font-bold text-white">
                    {driver?.licenseClass || 'Class 1 / AZ'} · {driver?.licenseNumber || 'On file'}
                  </div>
                  <div className="text-xs text-slate-300">
                    Expires: {formatDate(driver?.licenseExpiry ?? null)}
                  </div>
                </div>

                <div
                  className={`p-5 rounded-2xl border space-y-2 ${
                    medDays !== null && medDays <= 30
                      ? 'bg-amber-950/60 border-bro-gold'
                      : 'surface-ceramic'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-medium">DOT / NSC Medical Card</span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full font-semibold ${
                        medDays === null
                          ? 'bg-white/10 text-slate-300'
                          : medDays < 0
                            ? 'bg-rose-950 text-rose-200 border border-rose-500/40'
                            : medDays <= 30
                              ? 'bg-amber-950 text-bro-gold border border-bro-gold/40'
                              : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      }`}
                    >
                      {medDays === null
                        ? 'Unverified'
                        : medDays < 0
                          ? `Expired (${Math.abs(medDays)}d)`
                          : `${medDays} days left`}
                    </span>
                  </div>
                  <div className="font-display text-sm font-bold text-white">
                    {medDays !== null && medDays <= 30 ? 'Renewal Action Required' : 'Medical Cleared'}
                  </div>
                  <div className="text-xs text-slate-300">
                    Expires: {formatDate(driver?.medicalCardExpiry ?? null)}
                  </div>
                </div>

                <div className="p-5 rounded-2xl surface-ceramic space-y-2">
                  <div className="text-xs text-slate-300 font-medium">Active Pay Structure</div>
                  <div className="font-mono text-sm font-bold text-bro-cyan tabular-nums">
                    {driver
                      ? driver.payModel === 'cpm'
                        ? `$${(driver.payRateValue / 100).toFixed(2)} / loaded mile (CPM)`
                        : `${(driver.payRateValue / 100).toFixed(2)}% of Load Gross`
                      : '—'}
                  </div>
                  <div className="text-xs text-slate-300">
                    Direct deposit · Settlement PDF archived to Vault
                  </div>
                </div>
              </div>

              {/* Settlements Table */}
              <div className="rounded-2xl surface-ceramic overflow-hidden">
                <div className="p-5 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <DollarSign className="w-5 h-5 text-bro-gold shrink-0" aria-hidden="true" />
                    <h2 className="font-display text-base font-bold text-white tracking-tight">
                      Driver Settlement Statements ({settlements.length})
                    </h2>
                  </div>
                </div>

                {settlements.length === 0 ? (
                  <div className="p-8 text-center text-xs sm:text-sm text-slate-300">
                    No finalized driver settlements yet. Completed loads will appear on your bi-weekly pay statement.
                  </div>
                ) : (
                  <div className="divide-y divide-white/10">
                    {settlements.map((s) => (
                      <div
                        key={s.id}
                        className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-white/[0.02]"
                      >
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-white">{s.settlementNumber}</span>
                            <span
                              className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase border ${
                                s.status === 'paid'
                                  ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                                  : s.status === 'finalized'
                                    ? 'bg-cyan-500/20 border-bro-cyan/50 text-bro-cyan'
                                    : 'bg-[#060912] border-white/15 text-slate-300'
                              }`}
                            >
                              {s.status}
                            </span>
                          </div>
                          <div className="text-xs text-slate-300">
                            Period: {formatDate(s.periodStart)} – {formatDate(s.periodEnd)}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs tabular-nums">
                          <div>
                            <div className="text-xs text-slate-400">Gross</div>
                            <div className="text-slate-200">{formatMoneyCents(s.grossPayCents, s.currency)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-slate-400">Reimb.</div>
                            <div className="text-emerald-300">
                              +{formatMoneyCents(s.reimbursementsCents, s.currency)}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-slate-400">Deduct.</div>
                            <div className="text-rose-300">
                              -{formatMoneyCents(s.deductionsCents, s.currency)}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-slate-400">Net Pay</div>
                            <div className="text-bro-gold font-bold">{formatMoneyCents(s.netPayCents, s.currency)}</div>
                          </div>
                        </div>

                        {s.id ? (
                          <a
                            href={`/api/settlements/${encodeURIComponent(s.id)}/pdf`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-bro-cyan/40 bg-bro-cyan/10 hover:bg-bro-cyan hover:text-black text-bro-cyan text-xs font-semibold transition-colors shrink-0"
                          >
                            <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span>Download PDF</span>
                          </a>
                        ) : (
                          <span className="min-h-[44px] inline-flex items-center justify-center px-4 py-2.5 rounded-full border border-white/15 bg-[#060912] text-slate-300 text-xs font-medium shrink-0">
                            PDF Pending Finalization
                          </span>
                        )}
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
