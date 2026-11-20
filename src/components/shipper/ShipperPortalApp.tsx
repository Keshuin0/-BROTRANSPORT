import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Package,
  FileSpreadsheet,
  FileText,
  Receipt,
  Thermometer,
  Download,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Radio,
  Plus,
  Upload,
  X,
  RefreshCw,
  ArrowRight,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import {
  ALLOWED_DOC_MIMES,
  MAX_DOC_BYTES,
  type EquipmentType,
  type InvoiceLineItem,
  type InvoiceStatus,
  type LoadDirection,
  type LoadStatus,
  type OcrStatus,
} from '@bro/contracts';
import { BroWsClient, type WsEventMessage } from '../../lib/wsClient';
import { sha256Hex } from '../../lib/ebolCrypto';

type ShipperTab = 'shipments' | 'quotes' | 'vault' | 'billing';

interface ShipperLoad {
  id: string;
  loadNumber: string;
  shipperOrgId: string;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  status: LoadStatus;
  commodity: string;
  weightLbs: number;
  loadedMiles: number;
  tempSetpointC: number | null;
  isFoodFda: boolean;
  rateCustomerCents: number;
  currency: 'CAD' | 'USD';
  detentionMinutes: number;
  createdAt: number;
  updatedAt: number;
}

interface ShipperQuote {
  id: string;
  quoteRef: string;
  equipmentType: EquipmentType;
  originLabel: string;
  destLabel: string;
  distanceKm: number;
  weightLbs: number;
  commodity: string;
  tempSetpointC: number | null;
  linehaulCents: number;
  fscCents: number;
  customsCents: number;
  accessorialsCents: number;
  totalCents: number;
  currency: 'CAD' | 'USD';
  co2Kg: number;
  status: 'open' | 'booked' | 'expired';
  expiresAt: number;
  createdAt: number;
}

interface ShipperInvoice {
  id: string;
  invoiceNumber: string;
  loadId: string;
  shipperOrgId: string;
  currency: 'CAD' | 'USD';
  lineItemsJson: string;
  subtotalCents: number;
  taxCents: number;
  taxLabel: string;
  totalCents: number;
  status: InvoiceStatus;
  dueDate: number;
  paidAt: number | null;
  paymentRef: string | null;
  createdAt: number;
}

interface ShipperDocument {
  id: string;
  loadId: string | null;
  docType: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
  ocrStatus: OcrStatus;
  ocrConfidence: number | null;
  createdAt: number;
}

interface ShipperDashboardPayload {
  organizationId: string;
  loads: ShipperLoad[];
  quotes: ShipperQuote[];
  invoices: ShipperInvoice[];
  documents: ShipperDocument[];
}

interface TelematicsReading {
  id: string;
  equipmentId: string;
  loadId: string | null;
  lat: number;
  lon: number;
  reeferTempC: number | null;
  setpointC: number | null;
  doorClosed: boolean | null;
  axleWeightKg: number | null;
  tpmsPsi: number | null;
  rulHours: number | null;
  recordedAt: number;
}

interface TelemetryAuditPayload {
  load: ShipperLoad;
  telemetry: TelematicsReading[];
  ebolBlocksCount: number;
}

const LIFECYCLE_STAGES: readonly LoadStatus[] = [
  'QUOTED',
  'BOOKED',
  'DISPATCHED',
  'AT_PICKUP',
  'IN_TRANSIT',
  'AT_BORDER',
  'CLEARED',
  'AT_DELIVERY',
  'DELIVERED',
  'INVOICED',
  'PAID',
];

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

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function invoiceBadgeStyle(status: InvoiceStatus): string {
  switch (status) {
    case 'paid':
      return 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300';
    case 'sent':
    case 'factored':
      return 'bg-cyan-500/20 border-bro-cyan/50 text-bro-cyan';
    case 'pending_approval':
    case 'partially_paid':
      return 'bg-amber-500/20 border-bro-gold/60 text-bro-gold';
    case 'disputed':
      return 'bg-rose-500/20 border-bro-crimson text-rose-200';
    case 'draft':
    default:
      return 'bg-slate-800 border-white/15 text-slate-300';
  }
}

function ocrBadgeStyle(status: OcrStatus): string {
  switch (status) {
    case 'verified':
      return 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300';
    case 'awaiting_review':
      return 'bg-amber-500/20 border-bro-gold/60 text-bro-gold';
    case 'extracting':
      return 'bg-cyan-500/20 border-bro-cyan/50 text-bro-cyan';
    case 'rejected':
      return 'bg-rose-500/20 border-bro-crimson text-rose-200';
    case 'pending':
    default:
      return 'bg-slate-800 border-white/15 text-slate-300';
  }
}

function parseInvoiceLineItems(raw: string): InvoiceLineItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as InvoiceLineItem[]) : [];
  } catch {
    return [];
  }
}

function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default function ShipperPortalApp() {
  const [activeTab, setActiveTab] = useState<ShipperTab>('shipments');
  const [dashboard, setDashboard] = useState<ShipperDashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live WebSocket state
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'offline'>('offline');
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  // FSMA Temp Audit Modal state
  const [auditModalOpen, setAuditModalOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditData, setAuditData] = useState<TelemetryAuditPayload | null>(null);
  const closeAuditBtnRef = useRef<HTMLButtonElement | null>(null);

  // Quote Booking state
  const [bookingRef, setBookingRef] = useState<string | null>(null);
  const [bookingFeedback, setBookingFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Document Vault filter & Commercial Invoice Upload state
  const [vaultFilter, setVaultFilter] = useState<'all' | 'verified' | 'COMMERCIAL_INVOICE' | 'bol_pod'>('all');
  const [uploadLoadId, setUploadLoadId] = useState<string>('');
  const [uploadDocType, setUploadDocType] = useState<'COMMERCIAL_INVOICE' | 'PACKING_LIST' | 'BOL'>('COMMERCIAL_INVOICE');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadDigest, setUploadDigest] = useState<string | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/shipper/dashboard');
      const data = (await res.json().catch(() => ({}))) as ShipperDashboardPayload & { error?: string };
      if (!res.ok) {
        setErrorMsg(data.error || `Unable to load Shipper Portal (HTTP ${res.status}).`);
        return;
      }
      setDashboard(data);
      if (data.loads.length > 0) {
        setUploadLoadId((prev) => prev || data.loads[0].id);
      }
    } catch {
      setErrorMsg('Unable to reach #BRO Shipper API. Verify network connectivity.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchDashboard(false);
  }, [fetchDashboard]);

  // Connect BroWsClient on org:${orgId} with clean disconnect on unmount
  const orgId = dashboard?.organizationId ?? null;
  useEffect(() => {
    if (!orgId) return;
    const client = new BroWsClient(
      `org:${orgId}`,
      (msg: WsEventMessage) => {
        const label = msg.type.replace(/_/g, ' ');
        setLiveNotice(`Live update received: ${label} (${new Date(msg.timestamp || Date.now()).toLocaleTimeString()})`);
        void fetchDashboard(true);
      },
      (status) => setWsStatus(status),
    );
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [orgId, fetchDashboard]);

  // Accessibility: Escape key closes FSMA Temp Audit modal & manages focus
  useEffect(() => {
    if (!auditModalOpen) return;
    closeAuditBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAuditModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [auditModalOpen]);

  const handleOpenFsmaAudit = async (loadId: string) => {
    setAuditModalOpen(true);
    setAuditLoading(true);
    setAuditError(null);
    setAuditData(null);

    try {
      const res = await fetch(`/api/shipper/loads/${encodeURIComponent(loadId)}/telemetry`);
      const data = (await res.json().catch(() => ({}))) as TelemetryAuditPayload & { error?: string };
      if (!res.ok) {
        setAuditError(data.error || `Unable to retrieve FSMA telemetry (HTTP ${res.status}).`);
        return;
      }
      setAuditData(data);
    } catch {
      setAuditError('Network error while fetching cold-chain telemetry readings.');
    } finally {
      setAuditLoading(false);
    }
  };

  const handleDownloadFsmaCsv = () => {
    if (!auditData) return;
    const header = [
      'TimestampUTC',
      'LoadNumber',
      'EquipmentId',
      'ReeferTempC',
      'SetpointC',
      'DeltaC',
      'DoorClosed',
      'Lat',
      'Lon',
      'TpmsPsi',
      'RulHours',
    ];
    const rows = auditData.telemetry.map((t) => {
      const setpoint = t.setpointC ?? auditData.load.tempSetpointC;
      const delta =
        t.reeferTempC !== null && setpoint !== null
          ? Number((t.reeferTempC - setpoint).toFixed(2))
          : '';
      return [
        new Date(t.recordedAt).toISOString(),
        auditData.load.loadNumber,
        t.equipmentId,
        t.reeferTempC ?? '',
        setpoint ?? '',
        delta,
        t.doorClosed === null ? '' : t.doorClosed ? 'CLOSED' : 'OPEN',
        t.lat,
        t.lon,
        t.tpmsPsi ?? '',
        t.rulHours ?? '',
      ]
        .map(escapeCsvCell)
        .join(',');
    });

    const csv = [header.join(','), ...rows].join('\n') + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `FSMA_Temp_Audit_${auditData.load.loadNumber}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleBookQuote = async (quoteRef: string) => {
    setBookingRef(quoteRef);
    setBookingFeedback(null);

    try {
      const res = await fetch(`/api/shipper/quotes/${encodeURIComponent(quoteRef)}/book`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        loadId?: string;
        loadNumber?: string;
        error?: string;
      };
      if (!res.ok) {
        setBookingFeedback({
          type: 'error',
          message: data.error || `Booking failed (HTTP ${res.status}).`,
        });
        return;
      }
      setBookingFeedback({
        type: 'success',
        message: `Quote ${quoteRef} booked! Master Load ${data.loadNumber ?? data.loadId} created and dispatched to operations.`,
      });
      await fetchDashboard(true);
    } catch {
      setBookingFeedback({
        type: 'error',
        message: 'Network error while booking quote. Please try again.',
      });
    } finally {
      setBookingRef(null);
    }
  };

  const handleSelectShipperFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadStatus(null);
    setUploadDigest(null);
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setUploadFile(null);
      return;
    }
    if (file.size === 0 || file.size > MAX_DOC_BYTES) {
      setUploadStatus({
        type: 'error',
        message: `File must be between 1 byte and ${MAX_DOC_BYTES / (1024 * 1024)} MB.`,
      });
      setUploadFile(null);
      return;
    }
    if (file.type && !(ALLOWED_DOC_MIMES as readonly string[]).includes(file.type)) {
      setUploadStatus({
        type: 'error',
        message: 'Allowed formats: PDF, JPEG, PNG, or WebP.',
      });
      setUploadFile(null);
      return;
    }
    setUploadFile(file);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hex = await sha256Hex(bytes);
      setUploadDigest(hex);
    } catch {
      setUploadDigest(null);
    }
  };

  const handleUploadCommercialInvoice = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setUploadStatus(null);
    if (!uploadFile) {
      setUploadStatus({ type: 'error', message: 'Choose a Commercial Invoice PDF or scan first.' });
      return;
    }

    setUploadingDoc(true);
    try {
      const makeFormData = () => {
        const fd = new FormData();
        fd.append('file', uploadFile, uploadFile.name);
        fd.append('docType', uploadDocType);
        if (uploadLoadId) fd.append('loadId', uploadLoadId);
        return fd;
      };

      let res = await fetch('/api/shipper/documents/upload', {
        method: 'POST',
        body: makeFormData(),
      });

      // Fallback to unified vault upload endpoint when shipper upload route is not mounted separately
      if (res.status === 404) {
        res = await fetch('/api/driver/documents/upload', {
          method: 'POST',
          body: makeFormData(),
        });
      }

      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        documentId?: string;
        error?: string;
      };

      if (!res.ok) {
        setUploadStatus({
          type: 'error',
          message:
            data.error ||
            `Document upload unavailable (HTTP ${res.status}). Email customs documents to customs@brotransport.com or contact dispatch.`,
        });
        return;
      }

      setUploadStatus({
        type: 'success',
        message: `Uploaded ${uploadDocType} (${uploadFile.name}) — Vault ID: ${data.documentId ?? 'archived'}. Queued for customs OCR verification.`,
      });
      setUploadFile(null);
      setUploadDigest(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchDashboard(true);
    } catch {
      setUploadStatus({
        type: 'error',
        message: 'Network error while uploading commercial invoice.',
      });
    } finally {
      setUploadingDoc(false);
    }
  };

  const loads = dashboard?.loads ?? [];
  const quotes = dashboard?.quotes ?? [];
  const invoices = dashboard?.invoices ?? [];
  const docs = dashboard?.documents ?? [];

  const filteredDocs = docs.filter((d) => {
    if (vaultFilter === 'verified') return d.ocrStatus === 'verified';
    if (vaultFilter === 'COMMERCIAL_INVOICE') return d.docType === 'COMMERCIAL_INVOICE';
    if (vaultFilter === 'bol_pod') return d.docType === 'BOL' || d.docType === 'POD';
    return true;
  });

  // Compute Billing Totals grouped by currency (strictly integer cents)
  const openTotalsByCurrency = invoices.reduce<Record<string, number>>((acc, inv) => {
    if (inv.status !== 'paid') {
      acc[inv.currency] = (acc[inv.currency] ?? 0) + inv.totalCents;
    }
    return acc;
  }, {});
  const paidTotalsByCurrency = invoices.reduce<Record<string, number>>((acc, inv) => {
    if (inv.status === 'paid') {
      acc[inv.currency] = (acc[inv.currency] ?? 0) + inv.totalCents;
    }
    return acc;
  }, {});

  // FSMA audit summary metrics
  const tempReadings = auditData?.telemetry.filter((t) => t.reeferTempC !== null) ?? [];
  const minTemp =
    tempReadings.length > 0 ? Math.min(...tempReadings.map((t) => t.reeferTempC as number)) : null;
  const maxTemp =
    tempReadings.length > 0 ? Math.max(...tempReadings.map((t) => t.reeferTempC as number)) : null;
  const excursionCount = tempReadings.filter((t) => {
    const sp = t.setpointC ?? auditData?.load.tempSetpointC;
    return sp !== null && sp !== undefined && Math.abs((t.reeferTempC as number) - sp) > 2.0;
  }).length;
  const doorOpenCount = auditData?.telemetry.filter((t) => t.doorClosed === false).length ?? 0;

  const tabs: Array<{ id: ShipperTab; label: string; icon: typeof Package; count: number }> = [
    { id: 'shipments', label: 'Active Shipments', icon: Package, count: loads.length },
    { id: 'quotes', label: 'Quotes & Book', icon: FileSpreadsheet, count: quotes.length },
    { id: 'vault', label: 'Document Vault', icon: FileText, count: docs.length },
    { id: 'billing', label: 'Billing & Invoices', icon: Receipt, count: invoices.length },
  ];

  return (
    <div className="space-y-6">
      {/* Top Shipper Command Strip */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-5 rounded-lg bg-bro-steel/70 border border-bro-cyan/30 backdrop-blur-xl">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-bro-cyan">
            <ShieldCheck className="w-4 h-4" />
            <span>Shipper Command Portal</span>
            {orgId && (
              <span className="px-2 py-0.5 rounded bg-bro-obsidian/80 border border-white/10 text-slate-300">
                ORG: {orgId}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Real-time cross-border freight tracking, FSMA cold-chain audits, instant booking & zero-rated AR billing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start md:self-center">
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border font-mono text-[11px] uppercase ${
              wsStatus === 'connected'
                ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
                : wsStatus === 'connecting'
                  ? 'bg-cyan-950/70 border-bro-cyan/50 text-bro-cyan'
                  : 'bg-slate-900/80 border-white/15 text-slate-400'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>WS: {wsStatus}</span>
          </span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void fetchDashboard(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/15 bg-bro-obsidian/70 hover:border-bro-cyan text-slate-200 font-mono text-[11px] uppercase cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Sync</span>
          </button>
          <a
            href="/quote"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-bro-cyan hover:bg-cyan-300 text-black font-mono text-[11px] font-bold uppercase transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Quote</span>
          </a>
        </div>
      </div>

      {liveNotice && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-2 px-4 py-2.5 rounded bg-cyan-950/60 border border-bro-cyan/40 text-bro-cyan font-mono text-xs"
        >
          <span>{liveNotice}</span>
          <button
            type="button"
            onClick={() => setLiveNotice(null)}
            aria-label="Dismiss live notification"
            className="p-1 text-slate-300 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-4 rounded-lg bg-rose-950/70 border border-rose-500/50 text-rose-200 font-mono text-xs"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 4 Portal Tabs */}
      <div
        role="tablist"
        aria-label="Shipper Portal Sections"
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
              className={`flex-1 min-w-[150px] flex items-center justify-center gap-2 px-3 py-3 rounded font-mono text-xs font-bold uppercase tracking-wide transition-colors cursor-pointer whitespace-nowrap ${
                selected
                  ? 'bg-bro-cyan text-black'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{tab.label}</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums ${
                  selected ? 'bg-black/20 text-black' : 'bg-white/10 text-slate-200'
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="p-12 rounded-lg bg-bro-steel/50 border border-white/10 flex flex-col items-center justify-center gap-3 font-mono text-xs text-slate-400">
          <Loader2 className="w-6 h-6 text-bro-cyan animate-spin" />
          <span>Loading Organization Freight Ledger...</span>
        </div>
      ) : (
        <>
          {/* TAB 1: ACTIVE SHIPMENTS */}
          {activeTab === 'shipments' && (
            <div className="space-y-4">
              {loads.length === 0 ? (
                <div className="p-8 rounded-lg bg-bro-steel/50 border border-white/10 text-center space-y-3">
                  <Package className="w-8 h-8 text-slate-500 mx-auto" />
                  <div className="font-mono text-xs uppercase text-slate-300">No Active Shipments Found</div>
                  <p className="text-xs text-slate-400">
                    Book one of your saved quotes or request a live cross-border freight quote.
                  </p>
                  <a
                    href="/quote"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded bg-bro-cyan text-black font-mono text-xs font-bold uppercase"
                  >
                    <span>Get Instant Quote</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              ) : (
                loads.map((load) => {
                  const stageIdx = Math.max(0, LIFECYCLE_STAGES.indexOf(load.status));
                  const progressPct = Math.round(((stageIdx + 1) / LIFECYCLE_STAGES.length) * 100);
                  return (
                    <article
                      key={load.id}
                      className="rounded-lg bg-bro-steel/60 border border-white/10 p-5 space-y-4"
                    >
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-base font-bold text-white">{load.loadNumber}</span>
                            <span className="px-2 py-0.5 rounded bg-bro-cyan/15 border border-bro-cyan/40 font-mono text-[10px] font-bold uppercase text-bro-cyan">
                              {load.status.replace(/_/g, ' ')}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px] text-slate-300">
                              {DIRECTION_LABELS[load.direction]}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-bro-gold/10 border border-bro-gold/30 font-mono text-[10px] text-bro-gold">
                              {EQUIPMENT_LABELS[load.equipmentType]}
                            </span>
                            {load.isFoodFda && (
                              <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/40 font-mono text-[10px] text-emerald-300">
                                FSMA / FDA
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-slate-200 font-medium">{load.commodity}</div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400 tabular-nums">
                            <span>{load.weightLbs.toLocaleString()} lbs</span>
                            <span>{load.loadedMiles} mi</span>
                            {load.tempSetpointC !== null && (
                              <span className="text-bro-cyan">Target: {load.tempSetpointC.toFixed(1)}°C</span>
                            )}
                            <span className={load.detentionMinutes > 0 ? 'text-bro-gold font-bold' : ''}>
                              Detention: {load.detentionMinutes} min
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2.5">
                          <div className="px-3 py-2 rounded bg-bro-obsidian/80 border border-white/10 font-mono text-xs text-white font-bold tabular-nums">
                            {formatMoneyCents(load.rateCustomerCents, load.currency)}
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleOpenFsmaAudit(load.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-cyan-950/80 border border-bro-cyan/50 hover:bg-bro-cyan hover:text-black text-bro-cyan font-mono text-xs font-bold uppercase transition-colors cursor-pointer"
                          >
                            <Thermometer className="w-3.5 h-3.5" />
                            <span>FSMA Temp Audit</span>
                          </button>
                          <a
                            href={`/verify/${encodeURIComponent(load.id)}`}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded border border-white/15 bg-bro-obsidian/70 hover:border-bro-gold text-slate-200 hover:text-bro-gold font-mono text-xs font-bold uppercase transition-colors"
                          >
                            <span>eBOL Verify</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      </div>

                      {/* 11-Stage Lifecycle Progress Bar */}
                      <div className="space-y-2 pt-2 border-t border-white/10">
                        <div className="flex items-center justify-between font-mono text-[10px] uppercase text-slate-400 tabular-nums">
                          <span>
                            Stage {stageIdx + 1} / {LIFECYCLE_STAGES.length} ({load.status.replace(/_/g, ' ')})
                          </span>
                          <span>{progressPct}% Complete</span>
                        </div>
                        <div
                          className="h-2 w-full rounded-full bg-bro-obsidian overflow-hidden border border-white/10"
                          role="progressbar"
                          aria-valuenow={progressPct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`Shipment ${load.loadNumber} progress`}
                        >
                          <div
                            className="h-full bg-gradient-to-r from-bro-cyan to-emerald-400 transition-all"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-11 gap-1 pt-1">
                          {LIFECYCLE_STAGES.map((stage, idx) => {
                            const done = idx < stageIdx;
                            const current = idx === stageIdx;
                            return (
                              <div
                                key={stage}
                                className={`text-center px-1 py-1 rounded font-mono text-[9px] uppercase truncate ${
                                  current
                                    ? 'bg-bro-cyan text-black font-bold'
                                    : done
                                      ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30'
                                      : 'bg-bro-obsidian/50 text-slate-500'
                                }`}
                              >
                                {stage.replace(/_/g, ' ')}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 2: QUOTES & BOOK */}
          {activeTab === 'quotes' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-lg bg-bro-steel/60 border border-white/10">
                <div>
                  <h3 className="font-mono text-xs font-bold uppercase text-white">Saved Commercial Rate Quotes</h3>
                  <p className="text-xs text-slate-400">
                    Convert any active spot or corridor quote directly into a dispatched #BRO Transport load in 1 click.
                  </p>
                </div>
                <a
                  href="/quote"
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded bg-bro-gold hover:bg-amber-400 text-black font-mono text-xs font-bold uppercase transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span>Calculate New Quote</span>
                </a>
              </div>

              {bookingFeedback && (
                <div
                  role={bookingFeedback.type === 'error' ? 'alert' : 'status'}
                  aria-live="polite"
                  className={`flex flex-wrap items-center justify-between gap-3 p-4 rounded-lg border font-mono text-xs ${
                    bookingFeedback.type === 'success'
                      ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-100'
                      : 'bg-rose-950/70 border-rose-500/50 text-rose-200'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {bookingFeedback.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                    <span>{bookingFeedback.message}</span>
                  </div>
                  {bookingFeedback.type === 'success' && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('shipments')}
                      className="px-3 py-1 rounded bg-emerald-400 text-black font-bold uppercase text-[11px] cursor-pointer"
                    >
                      View Active Shipments
                    </button>
                  )}
                </div>
              )}

              {quotes.length === 0 ? (
                <div className="p-8 rounded-lg bg-bro-steel/50 border border-white/10 text-center space-y-3">
                  <FileSpreadsheet className="w-8 h-8 text-slate-500 mx-auto" />
                  <div className="font-mono text-xs uppercase text-slate-300">No Saved Quotes Yet</div>
                  <p className="text-xs text-slate-400">
                    Use our deterministic highway freight estimator to generate Dry Van, Reefer, or Flatbed quotes.
                  </p>
                  <a
                    href="/quote"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded bg-bro-cyan text-black font-mono text-xs font-bold uppercase"
                  >
                    <span>Open Quote Engine</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4">
                  {quotes.map((q) => {
                    const isExpired = q.status === 'expired' || (q.status === 'open' && q.expiresAt < Date.now());
                    const isBooking = bookingRef === q.quoteRef;
                    return (
                      <div
                        key={q.id}
                        className="p-5 rounded-lg bg-bro-steel/60 border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                      >
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-white">{q.quoteRef}</span>
                            <span
                              className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${
                                q.status === 'booked'
                                  ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                                  : isExpired
                                    ? 'bg-slate-800 border-white/15 text-slate-400'
                                    : 'bg-cyan-500/20 border-bro-cyan/50 text-bro-cyan'
                              }`}
                            >
                              {isExpired && q.status === 'open' ? 'expired' : q.status}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-bro-gold/10 border border-bro-gold/30 font-mono text-[10px] text-bro-gold">
                              {EQUIPMENT_LABELS[q.equipmentType]}
                            </span>
                          </div>
                          <div className="text-sm font-semibold text-white">
                            {q.originLabel} <span className="text-bro-cyan">→</span> {q.destLabel}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400 tabular-nums">
                            <span>{q.commodity}</span>
                            <span>{q.distanceKm.toLocaleString()} km</span>
                            <span>{q.weightLbs.toLocaleString()} lbs</span>
                            <span>{q.co2Kg} kg CO₂e</span>
                            <span className="inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" /> Valid until {formatDate(q.expiresAt)}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 shrink-0">
                          <div className="text-left sm:text-right font-mono tabular-nums">
                            <div className="text-base font-bold text-white">
                              {formatMoneyCents(q.totalCents, q.currency)}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              LH {formatMoneyCents(q.linehaulCents, q.currency)} · FSC{' '}
                              {formatMoneyCents(q.fscCents, q.currency)}
                            </div>
                          </div>

                          {q.status === 'open' && !isExpired ? (
                            <button
                              type="button"
                              disabled={isBooking}
                              onClick={() => void handleBookQuote(q.quoteRef)}
                              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-bro-cyan hover:bg-cyan-300 text-black font-mono text-xs font-bold uppercase disabled:opacity-50 transition-colors cursor-pointer"
                            >
                              {isBooking ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-4 h-4" />
                              )}
                              <span>{isBooking ? 'Booking...' : 'Book Load Now'}</span>
                            </button>
                          ) : (
                            <span className="px-3 py-2 rounded bg-bro-obsidian/80 border border-white/10 font-mono text-[11px] uppercase text-slate-400">
                              {q.status === 'booked' ? 'Booked ✓' : 'Expired'}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: DOCUMENT VAULT */}
          {activeTab === 'vault' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Verified BOL / POD / Commercial Invoices List */}
              <div className="lg:col-span-7 rounded-lg bg-bro-steel/60 border border-white/10 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-white">
                    <FileText className="w-4 h-4 text-bro-cyan" />
                    <span>Organization Document Vault ({filteredDocs.length})</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                    {(
                      [
                        { id: 'all', label: 'All' },
                        { id: 'verified', label: 'Verified' },
                        { id: 'bol_pod', label: 'BOL / POD' },
                        { id: 'COMMERCIAL_INVOICE', label: 'Commercial Inv.' },
                      ] as const
                    ).map((chip) => (
                      <button
                        key={chip.id}
                        type="button"
                        onClick={() => setVaultFilter(chip.id)}
                        className={`px-2.5 py-1 rounded border uppercase cursor-pointer ${
                          vaultFilter === chip.id
                            ? 'bg-bro-cyan text-black border-bro-cyan font-bold'
                            : 'bg-bro-obsidian/70 text-slate-300 border-white/10 hover:border-white/25'
                        }`}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredDocs.length === 0 ? (
                  <div className="p-8 rounded bg-bro-obsidian/60 border border-white/10 text-center font-mono text-xs text-slate-400">
                    No matching documents archived yet. Verified BOLs, signed PODs, and Commercial Invoices appear here.
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
                    {filteredDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="p-3.5 rounded-lg bg-bro-obsidian/80 border border-white/10 space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="px-2 py-0.5 rounded bg-white/10 font-mono text-[10px] font-bold uppercase text-white shrink-0">
                              {doc.docType}
                            </span>
                            <span className="font-mono text-xs text-slate-100 truncate">
                              {doc.originalFilename}
                            </span>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold uppercase shrink-0 ${ocrBadgeStyle(doc.ocrStatus)}`}
                          >
                            {doc.ocrStatus.replace(/_/g, ' ')}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-400 tabular-nums">
                          <span>
                            {(doc.sizeBytes / 1024).toFixed(1)} KB · SHA-256: {doc.sha256Hex.slice(0, 16)}…
                          </span>
                          <span>
                            {doc.ocrConfidence !== null ? `OCR ${(doc.ocrConfidence * 100).toFixed(0)}% · ` : ''}
                            {formatTimestamp(doc.createdAt)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Shipper Commercial Invoice Upload Form */}
              <form
                onSubmit={handleUploadCommercialInvoice}
                className="lg:col-span-5 rounded-lg bg-bro-steel/60 border border-bro-gold/30 p-5 space-y-4 self-start"
              >
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <Upload className="w-4 h-4 text-bro-gold" />
                  <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                    Upload Shipper Customs Document
                  </h3>
                </div>

                <p className="text-xs text-slate-400">
                  Attach your Commercial Invoice, Packing List, or Shipper BOL for CBSA / CBP pre-arrival filing.
                </p>

                <div className="space-y-1.5">
                  <label htmlFor="shipper-doc-load" className="block font-mono text-[11px] uppercase text-slate-300">
                    Associated Shipment
                  </label>
                  <select
                    id="shipper-doc-load"
                    value={uploadLoadId}
                    onChange={(e) => setUploadLoadId(e.target.value)}
                    className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm text-white outline-none focus:border-bro-gold"
                  >
                    <option value="">— Organization General Document —</option>
                    {loads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.loadNumber} · {l.commodity.slice(0, 30)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="shipper-doc-type" className="block font-mono text-[11px] uppercase text-slate-300">
                    Document Type
                  </label>
                  <select
                    id="shipper-doc-type"
                    value={uploadDocType}
                    onChange={(e) =>
                      setUploadDocType(e.target.value as 'COMMERCIAL_INVOICE' | 'PACKING_LIST' | 'BOL')
                    }
                    className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm text-white outline-none focus:border-bro-gold"
                  >
                    <option value="COMMERCIAL_INVOICE">COMMERCIAL_INVOICE — Customs Commercial Invoice</option>
                    <option value="PACKING_LIST">PACKING_LIST — Cargo Packing List</option>
                    <option value="BOL">BOL — Shipper Bill of Lading</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="shipper-doc-file" className="block font-mono text-[11px] uppercase text-slate-300">
                    PDF or Scan (Max 15 MB) *
                  </label>
                  <input
                    ref={fileInputRef}
                    id="shipper-doc-file"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,image/webp"
                    onChange={(e) => void handleSelectShipperFile(e)}
                    className="w-full text-xs font-mono text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:bg-bro-gold file:text-black file:font-bold file:uppercase file:cursor-pointer bg-bro-obsidian/80 border border-white/15 rounded p-2"
                  />
                  {uploadDigest && (
                    <div className="font-mono text-[10px] text-bro-cyan break-all">
                      Client SHA-256: {uploadDigest.slice(0, 32)}…
                    </div>
                  )}
                </div>

                {uploadStatus && (
                  <div
                    role={uploadStatus.type === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className={`p-3 rounded border font-mono text-xs ${
                      uploadStatus.type === 'success'
                        ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-200'
                        : 'bg-rose-950/70 border-rose-500/50 text-rose-200'
                    }`}
                  >
                    {uploadStatus.message}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={uploadingDoc || !uploadFile}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded bg-bro-gold hover:bg-amber-400 text-black font-mono text-xs font-bold uppercase disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {uploadingDoc ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Uploading to Vault...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>Upload Commercial Invoice</span>
                    </>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* TAB 4: BILLING & INVOICES */}
          {activeTab === 'billing' && (
            <div className="space-y-5">
              {/* Billing KPI Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-bro-steel/60 border border-white/10 space-y-1">
                  <div className="font-mono text-[10px] uppercase text-slate-400">Open Balance</div>
                  <div className="font-mono text-lg font-bold text-bro-gold tabular-nums">
                    {Object.keys(openTotalsByCurrency).length === 0
                      ? '$0.00'
                      : Object.entries(openTotalsByCurrency)
                          .map(([cur, cents]) => formatMoneyCents(cents, cur as 'CAD' | 'USD'))
                          .join(' · ')}
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-bro-steel/60 border border-white/10 space-y-1">
                  <div className="font-mono text-[10px] uppercase text-slate-400">Settled / Paid</div>
                  <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">
                    {Object.keys(paidTotalsByCurrency).length === 0
                      ? '$0.00'
                      : Object.entries(paidTotalsByCurrency)
                          .map(([cur, cents]) => formatMoneyCents(cents, cur as 'CAD' | 'USD'))
                          .join(' · ')}
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-bro-steel/60 border border-bro-cyan/30 space-y-1">
                  <div className="font-mono text-[10px] uppercase text-bro-cyan">Cross-Border Tax Treatment</div>
                  <div className="text-xs text-slate-200 font-medium">
                    0% Zero-Rated International Freight
                  </div>
                  <div className="font-mono text-[10px] text-slate-400">
                    Canada ETA Sch. VI, Part VII, s. 7 / 49 U.S.C. § 14505
                  </div>
                </div>
              </div>

              {/* Invoice List */}
              <div className="rounded-lg bg-bro-steel/60 border border-white/10 overflow-hidden">
                <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-white">
                    <Receipt className="w-4 h-4 text-bro-cyan" />
                    <span>Accounts Receivable Invoices ({invoices.length})</span>
                  </div>
                </div>

                {invoices.length === 0 ? (
                  <div className="p-8 text-center font-mono text-xs text-slate-400">
                    No invoices generated for your organization yet.
                  </div>
                ) : (
                  <div className="divide-y divide-white/10">
                    {invoices.map((inv) => {
                      const items = parseInvoiceLineItems(inv.lineItemsJson);
                      const isZeroRated = inv.taxCents === 0;
                      return (
                        <div key={inv.id} className="p-5 space-y-3 hover:bg-white/[0.02]">
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-sm font-bold text-white">{inv.invoiceNumber}</span>
                                <span
                                  className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold uppercase ${invoiceBadgeStyle(inv.status)}`}
                                >
                                  {inv.status.replace(/_/g, ' ')}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded font-mono text-[10px] border ${
                                    isZeroRated
                                      ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                                      : 'bg-white/5 border-white/10 text-slate-300'
                                  }`}
                                >
                                  {inv.taxLabel}
                                </span>
                              </div>
                              <div className="font-mono text-[11px] text-slate-400">
                                Load Ref: {inv.loadId} · Issued {formatDate(inv.createdAt)} · Due{' '}
                                {formatDate(inv.dueDate)}
                                {inv.paidAt ? ` · Paid ${formatDate(inv.paidAt)}` : ''}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-4">
                              <div className="text-left md:text-right font-mono tabular-nums">
                                <div className="text-[10px] text-slate-400 uppercase">
                                  Sub {formatMoneyCents(inv.subtotalCents, inv.currency)} + Tax{' '}
                                  {formatMoneyCents(inv.taxCents, inv.currency)}
                                </div>
                                <div className="text-base font-bold text-white">
                                  {formatMoneyCents(inv.totalCents, inv.currency)}
                                </div>
                              </div>

                              <a
                                href={`/api/billing/invoices/${encodeURIComponent(inv.id)}/pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-cyan/10 border border-bro-cyan/50 hover:bg-bro-cyan hover:text-black text-bro-cyan font-mono text-xs font-bold uppercase transition-colors"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>Download Invoice PDF</span>
                              </a>
                            </div>
                          </div>

                          {items.length > 0 && (
                            <div className="rounded bg-bro-obsidian/70 border border-white/10 p-3 space-y-1 font-mono text-[11px] tabular-nums">
                              {items.map((li, idx) => (
                                <div
                                  key={`${inv.id}-li-${idx}`}
                                  className="flex items-center justify-between gap-2 text-slate-300"
                                >
                                  <span>
                                    <span className="text-slate-500 mr-2">[{li.code}]</span>
                                    {li.description}
                                  </span>
                                  <span className="text-white">{formatMoneyCents(li.amountCents, inv.currency)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* FSMA Cold-Chain Temperature Audit Modal */}
      {auditModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fsma-audit-title"
        >
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setAuditModalOpen(false)}
          />
          <div className="relative z-10 w-full max-w-3xl max-h-[88vh] flex flex-col rounded-lg bg-bro-obsidian border border-bro-cyan/40 shadow-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between gap-3 bg-bro-steel/70">
              <div className="flex items-center gap-2">
                <Thermometer className="w-5 h-5 text-bro-cyan" />
                <div>
                  <h2 id="fsma-audit-title" className="font-mono text-xs sm:text-sm font-bold uppercase text-white">
                    FSMA 21 CFR §1.908 Cold-Chain Temperature Audit
                  </h2>
                  {auditData && (
                    <p className="font-mono text-[11px] text-slate-400">
                      {auditData.load.loadNumber} · {auditData.load.commodity}
                    </p>
                  )}
                </div>
              </div>
              <button
                ref={closeAuditBtnRef}
                type="button"
                onClick={() => setAuditModalOpen(false)}
                aria-label="Close FSMA temperature audit modal"
                className="p-1.5 rounded border border-white/15 text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4">
              {auditLoading ? (
                <div className="py-10 flex items-center justify-center gap-2 font-mono text-xs text-slate-400">
                  <Loader2 className="w-5 h-5 text-bro-cyan animate-spin" />
                  <span>Loading reefer sensor telemetry...</span>
                </div>
              ) : auditError ? (
                <div
                  role="alert"
                  className="p-4 rounded bg-rose-950/70 border border-rose-500/50 text-rose-200 font-mono text-xs"
                >
                  {auditError}
                </div>
              ) : auditData ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums">
                    <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] uppercase text-slate-400">Target Setpoint</div>
                      <div className="text-sm font-bold text-bro-cyan mt-0.5">
                        {auditData.load.tempSetpointC !== null
                          ? `${auditData.load.tempSetpointC.toFixed(1)}°C`
                          : 'Ambient / Dry'}
                      </div>
                    </div>
                    <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] uppercase text-slate-400">Min / Max Recorded</div>
                      <div className="text-sm font-bold text-white mt-0.5">
                        {minTemp !== null && maxTemp !== null
                          ? `${minTemp.toFixed(1)}°C / ${maxTemp.toFixed(1)}°C`
                          : 'No sensor pts'}
                      </div>
                    </div>
                    <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] uppercase text-slate-400">Temp Excursions</div>
                      <div
                        className={`text-sm font-bold mt-0.5 ${
                          excursionCount > 0 ? 'text-rose-400' : 'text-emerald-400'
                        }`}
                      >
                        {excursionCount} ({doorOpenCount} door open)
                      </div>
                    </div>
                    <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] uppercase text-slate-400">eBOL Custody Blocks</div>
                      <div className="text-sm font-bold text-white mt-0.5">
                        {auditData.ebolBlocksCount} Signed
                      </div>
                    </div>
                  </div>

                  {auditData.telemetry.length === 0 ? (
                    <div className="p-6 rounded bg-bro-steel/50 border border-white/10 text-center font-mono text-xs text-slate-400">
                      No telematics sensor events logged for this load yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded border border-white/10">
                      <table className="w-full text-left font-mono text-xs tabular-nums">
                        <thead className="bg-bro-steel/80 text-[10px] uppercase text-slate-400 border-b border-white/10">
                          <tr>
                            <th className="px-3 py-2.5">Timestamp</th>
                            <th className="px-3 py-2.5">Temp (°C)</th>
                            <th className="px-3 py-2.5">Setpoint</th>
                            <th className="px-3 py-2.5">Door</th>
                            <th className="px-3 py-2.5">GPS Coords</th>
                            <th className="px-3 py-2.5">TPMS / RUL</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10">
                          {auditData.telemetry.map((t) => {
                            const sp = t.setpointC ?? auditData.load.tempSetpointC;
                            const isExcursion =
                              t.reeferTempC !== null && sp !== null && Math.abs(t.reeferTempC - sp) > 2.0;
                            return (
                              <tr key={t.id} className="hover:bg-white/[0.02]">
                                <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
                                  {formatTimestamp(t.recordedAt)}
                                </td>
                                <td
                                  className={`px-3 py-2 font-bold ${
                                    isExcursion ? 'text-rose-400' : 'text-emerald-300'
                                  }`}
                                >
                                  {t.reeferTempC !== null ? `${t.reeferTempC.toFixed(1)}°C` : '—'}
                                </td>
                                <td className="px-3 py-2 text-slate-400">
                                  {sp !== null ? `${sp.toFixed(1)}°C` : '—'}
                                </td>
                                <td className="px-3 py-2">
                                  {t.doorClosed === null ? (
                                    '—'
                                  ) : t.doorClosed ? (
                                    <span className="text-emerald-400">SEALED</span>
                                  ) : (
                                    <span className="text-bro-gold font-bold">OPEN</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-slate-400">
                                  {t.lat.toFixed(3)}, {t.lon.toFixed(3)}
                                </td>
                                <td className="px-3 py-2 text-slate-400">
                                  {t.tpmsPsi ? `${t.tpmsPsi} psi` : '—'}
                                  {t.rulHours ? ` · ${t.rulHours}h` : ''}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : null}
            </div>

            <div className="p-4 border-t border-white/10 bg-bro-steel/70 flex flex-wrap items-center justify-between gap-3">
              {auditData ? (
                <a
                  href={`/verify/${encodeURIComponent(auditData.load.id)}`}
                  className="inline-flex items-center gap-1.5 font-mono text-xs text-bro-cyan hover:underline"
                >
                  <span>Verify eBOL Cryptographic Chain</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {auditData && (
                  <button
                    type="button"
                    onClick={handleDownloadFsmaCsv}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-cyan hover:bg-cyan-300 text-black font-mono text-xs font-bold uppercase cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download FSMA CSV</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setAuditModalOpen(false)}
                  className="px-3.5 py-2 rounded border border-white/15 text-slate-300 hover:text-white font-mono text-xs uppercase cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
