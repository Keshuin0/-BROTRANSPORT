import { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileImage,
  FileSearch,
  FileText,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Wifi,
  WifiOff,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { DocumentType, OcrExtractedPayload, OcrStatus } from '@bro/contracts';
import { BroWsClient } from '../../lib/wsClient';

interface DocumentRow {
  id: string;
  loadId: string | null;
  driverId: string | null;
  orgId: string | null;
  docType: DocumentType | string;
  r2Key: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
  ocrStatus: OcrStatus;
  ocrJson: string | null;
  ocrConfidence: number | null;
  reviewNotes: string | null;
  verifiedBy: string | null;
  verifiedAt: number | null;
  workflowInstanceId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EditableOcrFields {
  bolNumber: string;
  papsOrParsNumber: string;
  weightLbs: string;
  totalAmountCents: string;
  currency: 'CAD' | 'USD';
  hasOsdDamageOrShortage: boolean;
  osdNotes: string;
  fuelLiters: string;
  jurisdictionCode: string;
}

function confidenceBadgeStyle(score: number | null | undefined): {
  label: string;
  classes: string;
} {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return {
      label: 'N/A',
      classes: 'bg-slate-800 text-slate-400 border-slate-700',
    };
  }
  const pct = Math.round(score * 100);
  if (pct >= 92) {
    return {
      label: `${pct}%`,
      classes: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/45',
    };
  }
  if (pct >= 75) {
    return {
      label: `${pct}%`,
      classes: 'bg-bro-gold/15 text-bro-gold border-bro-gold/45',
    };
  }
  return {
    label: `${pct}%`,
    classes: 'bg-bro-crimson/15 text-bro-crimson border-bro-crimson/45',
  };
}

function parseOcrPayload(raw: string | null): Partial<OcrExtractedPayload> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<OcrExtractedPayload>;
  } catch {
    return {};
  }
}

function formatCentsPreview(centsStr: string, currency: 'CAD' | 'USD'): string {
  const num = Number.parseInt(centsStr, 10);
  if (!Number.isFinite(num)) return '$0.00';
  const formatted = (Math.abs(num) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${num < 0 ? '-' : ''}$${formatted} ${currency}`;
}

export default function DocOcrReviewQueue() {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [filter, setFilter] = useState<'awaiting_review' | 'verified' | 'rejected' | 'all'>('awaiting_review');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [banner, setBanner] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Viewer controls
  const [zoomPct, setZoomPct] = useState(100);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);

  // Editable right-pane fields
  const [fields, setFields] = useState<EditableOcrFields>({
    bolNumber: '',
    papsOrParsNumber: '',
    weightLbs: '',
    totalAmountCents: '',
    currency: 'CAD',
    hasOsdDamageOrShortage: false,
    osdNotes: '',
    fuelLiters: '',
    jurisdictionCode: '',
  });
  const [reviewerNotes, setReviewerNotes] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch('/api/ops/documents');
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ kind: 'error', text: err.error || `Failed to load OCR document queue (HTTP ${res.status}).` });
        return;
      }
      const data = (await res.json()) as { documents: DocumentRow[] };
      const list = data.documents || [];
      setDocs(list);
      setSelectedId((prev) => {
        if (prev && list.some((d) => d.id === prev)) return prev;
        const firstPending = list.find((d) => d.ocrStatus === 'awaiting_review');
        return firstPending?.id ?? list[0]?.id ?? null;
      });
    } catch {
      setBanner({ kind: 'error', text: 'Network error fetching document review queue.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  // Live OpsHub WS refresh on DOC_OCR_READY with mandatory disconnect cleanup
  useEffect(() => {
    const client = new BroWsClient(
      'ops:all',
      (msg) => {
        if (msg.type === 'DOC_OCR_READY') {
          setBanner({
            kind: 'info',
            text: `New AI OCR extraction ready for review (${String(msg.payload?.docType ?? 'Document')}). Queue refreshed.`,
          });
          void fetchDocuments();
        }
      },
      (status) => setWsStatus(status),
    );
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [fetchDocuments]);

  const filteredDocs = docs.filter((d) => (filter === 'all' ? true : d.ocrStatus === filter));
  const selectedDoc = docs.find((d) => d.id === selectedId) || filteredDocs[0] || null;
  const parsedOcr = parseOcrPayload(selectedDoc?.ocrJson ?? null);

  // Sync editable form fields & reset viewer when selected document changes
  useEffect(() => {
    if (!selectedDoc) return;
    const ocr = parseOcrPayload(selectedDoc.ocrJson);
    setFields({
      bolNumber: ocr.bolNumber ?? '',
      papsOrParsNumber: ocr.papsOrParsNumber ?? '',
      weightLbs: ocr.weightLbs !== undefined ? String(ocr.weightLbs) : '',
      totalAmountCents: ocr.totalAmountCents !== undefined ? String(ocr.totalAmountCents) : '',
      currency: ocr.currency ?? 'CAD',
      hasOsdDamageOrShortage: Boolean(ocr.hasOsdDamageOrShortage),
      osdNotes: ocr.osdNotes ?? '',
      fuelLiters: ocr.fuelLiters !== undefined ? String(ocr.fuelLiters) : '',
      jurisdictionCode: ocr.jurisdictionCode ?? '',
    });
    setReviewerNotes(selectedDoc.reviewNotes ?? '');
    setZoomPct(100);
    setRotationDeg(0);
    setPreviewError(null);
  }, [selectedDoc?.id, selectedDoc?.updatedAt]);

  // Fetch PDF as local Blob URL so X-Frame-Options never blocks same-origin iframe rendering
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setPdfBlobUrl(null);

    if (!selectedDoc || selectedDoc.mimeType !== 'application/pdf') {
      return;
    }

    const loadPdf = async () => {
      try {
        const res = await fetch(`/api/ops/documents/${encodeURIComponent(selectedDoc.id)}/file`);
        if (!res.ok) {
          if (active) setPreviewError(`R2 PDF binary unavailable (HTTP ${res.status}).`);
          return;
        }
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (active) {
          setPdfBlobUrl(objectUrl);
          setPreviewError(null);
        }
      } catch {
        if (active) setPreviewError('Unable to stream PDF binary from R2 vault.');
      }
    };

    void loadPdf();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedDoc?.id, selectedDoc?.mimeType]);

  const handleDecision = async (decision: 'approve' | 'reject') => {
    if (!selectedDoc) return;
    setDecisionBusy(true);
    setBanner(null);

    const correctedFields: Record<string, unknown> = {
      bolNumber: fields.bolNumber.trim() || undefined,
      papsOrParsNumber: fields.papsOrParsNumber.trim() || undefined,
      weightLbs: fields.weightLbs !== '' && Number.isFinite(Number(fields.weightLbs)) ? Number(fields.weightLbs) : undefined,
      totalAmountCents:
        fields.totalAmountCents !== '' && Number.isFinite(Number.parseInt(fields.totalAmountCents, 10))
          ? Number.parseInt(fields.totalAmountCents, 10)
          : undefined,
      currency: fields.currency,
      hasOsdDamageOrShortage: fields.hasOsdDamageOrShortage,
      osdNotes: fields.osdNotes.trim() || undefined,
      fuelLiters: fields.fuelLiters !== '' && Number.isFinite(Number(fields.fuelLiters)) ? Number(fields.fuelLiters) : undefined,
      jurisdictionCode: fields.jurisdictionCode.trim().toUpperCase() || undefined,
    };

    try {
      const res = await fetch(`/api/ops/documents/${encodeURIComponent(selectedDoc.id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          correctedFields,
          reviewerNotes: reviewerNotes.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; ocrStatus?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || `Failed to submit decision (HTTP ${res.status}).` });
      } else {
        setBanner({
          kind: 'success',
          text:
            decision === 'approve'
              ? `Document ${selectedDoc.originalFilename} VERIFIED — downstream billing/customs workflow resumed.`
              : `Document ${selectedDoc.originalFilename} REJECTED — rescan requested from uploader.`,
        });
        await fetchDocuments();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error submitting HITL verification decision.' });
    } finally {
      setDecisionBusy(false);
    }
  };

  const countByStatus = {
    awaiting_review: docs.filter((d) => d.ocrStatus === 'awaiting_review').length,
    verified: docs.filter((d) => d.ocrStatus === 'verified').length,
    rejected: docs.filter((d) => d.ocrStatus === 'rejected').length,
    all: docs.length,
  };

  const overallConf = selectedDoc?.ocrConfidence ?? parsedOcr.overallConfidence ?? null;
  const overallBadge = confidenceBadgeStyle(overallConf);
  const fieldConf = parsedOcr.fieldConfidences ?? {};
  const reviewReasons = parsedOcr.reviewReasons ?? [];

  const renderFieldConf = (key: string) => {
    const score = fieldConf[key];
    if (score === undefined) return null;
    const badge = confidenceBadgeStyle(score);
    return (
      <span className={`px-1.5 py-0.5 rounded border font-mono text-[9px] tabular-nums ${badge.classes}`}>
        {badge.label}
      </span>
    );
  };

  const fileUrl = selectedDoc ? `/api/ops/documents/${encodeURIComponent(selectedDoc.id)}/file` : '';

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-cyan">
            MODULE 02 // CLOUDFLARE WORKFLOW HITL DOCUMENT VERIFICATION
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            AI Document OCR Review Queue
          </h1>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border font-mono text-[10px] uppercase ${
              wsStatus === 'connected'
                ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-900 border-slate-700 text-slate-400'
            }`}
          >
            {wsStatus === 'connected' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            DOC_OCR_READY: {wsStatus}
          </span>
          <button
            type="button"
            onClick={() => void fetchDocuments()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 font-mono text-xs text-white cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Inline Banner */}
      {banner && (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border font-mono text-xs ${
            banner.kind === 'error'
              ? 'bg-rose-950/50 border-bro-crimson/40 text-rose-200'
              : banner.kind === 'info'
                ? 'bg-bro-cyan/10 border-bro-cyan/40 text-bro-cyan'
                : 'bg-emerald-950/50 border-emerald-500/40 text-emerald-200'
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 3-Pane OCR Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* LEFT PANE: Filterable Queue */}
        <aside className="xl:col-span-3 glass-panel rounded-lg border border-white/10 overflow-hidden flex flex-col max-h-[760px]">
          <div className="p-3 border-b border-white/10 space-y-2.5 bg-bro-obsidian/60">
            <div className="flex items-center justify-between font-mono text-[11px] font-bold uppercase text-white">
              <span>Document Queue</span>
              <span className="text-slate-400 tabular-nums">{filteredDocs.length} shown</span>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  ['awaiting_review', 'Review'],
                  ['verified', 'Verified'],
                  ['rejected', 'Rejected'],
                  ['all', 'All'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`px-2 py-1.5 rounded font-mono text-[10px] uppercase border transition-colors cursor-pointer flex items-center justify-between ${
                    filter === key
                      ? 'bg-bro-cyan/15 border-bro-cyan/45 text-bro-cyan font-bold'
                      : 'bg-bro-obsidian/70 border-white/10 text-slate-400 hover:text-white'
                  }`}
                >
                  <span>{label}</span>
                  <span className="tabular-nums">{countByStatus[key]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-white/5 overflow-y-auto flex-1">
            {loading ? (
              <div className="p-6 text-center font-mono text-xs text-slate-500">Loading OCR queue...</div>
            ) : filteredDocs.length === 0 ? (
              <div className="p-8 text-center font-mono text-xs text-slate-500 space-y-2">
                <FileSearch className="w-6 h-6 mx-auto text-slate-600" />
                <p>No documents in &ldquo;{filter}&rdquo;.</p>
                <p className="text-[10px] text-slate-600">
                  Driver &amp; shipper uploads trigger Vision OCR automatically and stream here.
                </p>
              </div>
            ) : (
              filteredDocs.map((doc) => {
                const isSelected = selectedDoc?.id === doc.id;
                const badge = confidenceBadgeStyle(doc.ocrConfidence);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => setSelectedId(doc.id)}
                    className={`w-full text-left p-3 transition-colors cursor-pointer space-y-1.5 ${
                      isSelected ? 'bg-bro-cyan/10 border-l-2 border-l-bro-cyan' : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="px-1.5 py-0.5 rounded bg-bro-steel border border-white/10 font-mono text-[10px] font-bold text-white">
                        {doc.docType}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded border font-mono text-[10px] font-bold tabular-nums ${badge.classes}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="text-xs font-medium text-slate-100 truncate">{doc.originalFilename}</div>
                    <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                      <span>{doc.loadId || 'Unlinked'}</span>
                      <span className="uppercase">{doc.ocrStatus.replace(/_/g, ' ')}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* CENTER PANE: High-Res R2 Document Viewer */}
        <section
          aria-label="R2 Document Viewer"
          className="xl:col-span-5 glass-panel rounded-lg border border-white/10 overflow-hidden flex flex-col min-h-[620px] max-h-[760px]"
        >
          <div className="px-4 py-3 border-b border-white/10 bg-bro-obsidian/70 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {selectedDoc?.mimeType === 'application/pdf' ? (
                <FileText className="w-4 h-4 text-bro-gold shrink-0" />
              ) : (
                <FileImage className="w-4 h-4 text-bro-cyan shrink-0" />
              )}
              <span className="font-mono text-xs font-bold text-white truncate">
                {selectedDoc ? selectedDoc.originalFilename : 'No document selected'}
              </span>
            </div>

            {selectedDoc && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setZoomPct((z) => Math.max(50, z - 25))}
                  aria-label="Zoom out"
                  className="p-1.5 rounded bg-bro-steel border border-white/10 hover:border-bro-cyan/40 text-slate-300 hover:text-white cursor-pointer"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="font-mono text-[10px] tabular-nums text-slate-300 w-10 text-center">
                  {zoomPct}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoomPct((z) => Math.min(250, z + 25))}
                  aria-label="Zoom in"
                  className="p-1.5 rounded bg-bro-steel border border-white/10 hover:border-bro-cyan/40 text-slate-300 hover:text-white cursor-pointer"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                {selectedDoc.mimeType.startsWith('image/') && (
                  <button
                    type="button"
                    onClick={() => setRotationDeg((r) => (r + 90) % 360)}
                    aria-label="Rotate document 90 degrees"
                    className="p-1.5 rounded bg-bro-steel border border-white/10 hover:border-bro-cyan/40 text-slate-300 hover:text-white cursor-pointer"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                )}
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded bg-bro-steel border border-white/10 hover:border-bro-cyan/40 font-mono text-[10px] text-bro-cyan"
                >
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>

          <div className="flex-1 bg-black/70 overflow-auto flex items-center justify-center p-4 relative">
            {!selectedDoc ? (
              <div className="text-center font-mono text-xs text-slate-500">
                Select a document from the left queue to inspect its R2 vault scan.
              </div>
            ) : previewError ? (
              <div className="max-w-sm text-center space-y-3 p-6 rounded-lg bg-bro-steel/70 border border-white/10 font-mono text-xs">
                <AlertTriangle className="w-6 h-6 text-bro-gold mx-auto" />
                <div className="text-slate-200">{previewError}</div>
                <div className="text-[10px] text-slate-400 break-all">R2 Key: {selectedDoc.r2Key}</div>
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-cyan/15 border border-bro-cyan/40 text-bro-cyan text-[11px]"
                >
                  Direct R2 Stream <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            ) : selectedDoc.mimeType === 'application/pdf' ? (
              pdfBlobUrl ? (
                <iframe
                  title={`PDF preview for ${selectedDoc.originalFilename}`}
                  src={pdfBlobUrl}
                  className="w-full h-[640px] rounded border border-white/10 bg-white"
                  style={{ transform: `scale(${zoomPct / 100})`, transformOrigin: 'top center' }}
                />
              ) : (
                <div className="font-mono text-xs text-slate-400">Streaming PDF from R2 vault...</div>
              )
            ) : (
              <img
                src={fileUrl}
                alt={`Scanned freight document ${selectedDoc.originalFilename}`}
                onError={() => setPreviewError('Image binary not found in local R2 vault or access denied.')}
                className="max-w-full rounded shadow-xl border border-white/10 transition-transform"
                style={{
                  transform: `scale(${zoomPct / 100}) rotate(${rotationDeg}deg)`,
                  transformOrigin: 'center center',
                }}
              />
            )}
          </div>

          {selectedDoc && (
            <div className="px-4 py-2 border-t border-white/10 bg-bro-obsidian/80 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-400">
              <span>MIME: {selectedDoc.mimeType}</span>
              <span className="tabular-nums">{(selectedDoc.sizeBytes / 1024).toFixed(1)} KB</span>
              <span className="truncate max-w-[200px]">SHA-256: {selectedDoc.sha256Hex.slice(0, 16)}…</span>
            </div>
          )}
        </section>

        {/* RIGHT PANE: Editable AI-Extracted JSON & HITL Decision */}
        <section
          aria-label="AI Extracted OCR Fields and HITL Decision"
          className="xl:col-span-4 glass-panel rounded-lg border border-white/10 p-4 space-y-4 max-h-[760px] overflow-y-auto"
        >
          {!selectedDoc ? (
            <div className="py-16 text-center font-mono text-xs text-slate-500">
              No document selected for field verification.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div>
                  <div className="font-mono text-xs font-bold uppercase text-white">
                    AI-Extracted Structured Fields
                  </div>
                  <div className="font-mono text-[10px] text-slate-400 mt-0.5">
                    HITL Auto-Approve Gate: &gt;= 92% · Zero OS&amp;D
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded border font-mono text-xs font-bold tabular-nums ${overallBadge.classes}`}>
                  Conf: {overallBadge.label}
                </span>
              </div>

              {/* Confidence Legend */}
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span className="px-1.5 py-0.5 rounded bg-bro-cyan/15 text-bro-cyan border border-bro-cyan/40">&gt;=92% High</span>
                <span className="px-1.5 py-0.5 rounded bg-bro-gold/15 text-bro-gold border border-bro-gold/40">75–91% Review</span>
                <span className="px-1.5 py-0.5 rounded bg-bro-crimson/15 text-bro-crimson border border-bro-crimson/40">&lt;75% Low</span>
              </div>

              {/* HITL Review Reasons */}
              {reviewReasons.length > 0 && (
                <div className="p-3 rounded-lg bg-rose-950/40 border border-bro-crimson/40 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase text-bro-crimson">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    HITL Escalation Reasons ({reviewReasons.length})
                  </div>
                  <ul className="list-disc pl-4 space-y-1 font-mono text-[11px] text-rose-100">
                    {reviewReasons.map((reason, idx) => (
                      <li key={idx}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Editable Extraction Inputs */}
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="ocr-bol" className="font-mono text-[10px] uppercase text-slate-300">
                      BOL Number
                    </label>
                    {renderFieldConf('bolNumber')}
                  </div>
                  <input
                    id="ocr-bol"
                    type="text"
                    value={fields.bolNumber}
                    onChange={(e) => setFields({ ...fields, bolNumber: e.target.value })}
                    placeholder="e.g. BOL-9948201"
                    className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-3 py-1.5 font-mono text-xs text-white outline-none"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="ocr-paps" className="font-mono text-[10px] uppercase text-slate-300">
                      PAPS / PARS Control #
                    </label>
                    {renderFieldConf('papsOrParsNumber')}
                  </div>
                  <input
                    id="ocr-paps"
                    type="text"
                    value={fields.papsOrParsNumber}
                    onChange={(e) => setFields({ ...fields, papsOrParsNumber: e.target.value })}
                    placeholder="e.g. BROP8843921"
                    className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-3 py-1.5 font-mono text-xs text-white outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="ocr-weight" className="font-mono text-[10px] uppercase text-slate-300">
                        Weight (lbs)
                      </label>
                      {renderFieldConf('weightLbs')}
                    </div>
                    <input
                      id="ocr-weight"
                      type="number"
                      value={fields.weightLbs}
                      onChange={(e) => setFields({ ...fields, weightLbs: e.target.value })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-3 py-1.5 font-mono text-xs text-white tabular-nums outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="ocr-cents" className="font-mono text-[10px] uppercase text-slate-300">
                        Total (Integer Cents)
                      </label>
                      {renderFieldConf('totalAmountCents')}
                    </div>
                    <input
                      id="ocr-cents"
                      type="number"
                      step={1}
                      value={fields.totalAmountCents}
                      onChange={(e) => setFields({ ...fields, totalAmountCents: e.target.value })}
                      placeholder="e.g. 385000"
                      className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-3 py-1.5 font-mono text-xs text-white tabular-nums outline-none"
                    />
                    {fields.totalAmountCents && (
                      <div className="font-mono text-[10px] text-bro-cyan tabular-nums mt-0.5">
                        = {formatCentsPreview(fields.totalAmountCents, fields.currency)}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <label htmlFor="ocr-currency" className="block font-mono text-[10px] uppercase text-slate-300 mb-1">
                      Currency
                    </label>
                    <select
                      id="ocr-currency"
                      value={fields.currency}
                      onChange={(e) => setFields({ ...fields, currency: e.target.value as 'CAD' | 'USD' })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white"
                    >
                      <option value="CAD">CAD</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="ocr-fuel" className="font-mono text-[10px] uppercase text-slate-300">
                        Fuel (L)
                      </label>
                      {renderFieldConf('fuelLiters')}
                    </div>
                    <input
                      id="ocr-fuel"
                      type="number"
                      step="0.1"
                      value={fields.fuelLiters}
                      onChange={(e) => setFields({ ...fields, fuelLiters: e.target.value })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-2.5 py-1.5 font-mono text-xs text-white tabular-nums outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="ocr-jur" className="font-mono text-[10px] uppercase text-slate-300">
                        IFTA Jur
                      </label>
                      {renderFieldConf('jurisdictionCode')}
                    </div>
                    <input
                      id="ocr-jur"
                      type="text"
                      maxLength={2}
                      value={fields.jurisdictionCode}
                      onChange={(e) => setFields({ ...fields, jurisdictionCode: e.target.value.toUpperCase() })}
                      placeholder="NB"
                      className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-2.5 py-1.5 font-mono text-xs text-white uppercase outline-none"
                    />
                  </div>
                </div>

                {/* OS&D Damage / Shortage Toggle */}
                <div className="p-3 rounded bg-bro-obsidian/80 border border-white/10 space-y-2">
                  <label className="flex items-center gap-2 font-mono text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={fields.hasOsdDamageOrShortage}
                      onChange={(e) => setFields({ ...fields, hasOsdDamageOrShortage: e.target.checked })}
                      className="rounded border-white/20"
                    />
                    <span className={fields.hasOsdDamageOrShortage ? 'text-bro-crimson font-bold' : ''}>
                      OS&amp;D Damage / Shortage Flag
                    </span>
                  </label>
                  {fields.hasOsdDamageOrShortage && (
                    <input
                      type="text"
                      value={fields.osdNotes}
                      onChange={(e) => setFields({ ...fields, osdNotes: e.target.value })}
                      placeholder="Detail OS&D damage or piece count shortage..."
                      className="w-full rounded bg-bro-steel border border-bro-crimson/40 px-2.5 py-1.5 font-mono text-xs text-white outline-none"
                    />
                  )}
                </div>

                {/* Reviewer Notes */}
                <div>
                  <label htmlFor="ocr-reviewer-notes" className="block font-mono text-[10px] uppercase text-slate-300 mb-1">
                    Reviewer Audit Notes (Max 500 chars)
                  </label>
                  <textarea
                    id="ocr-reviewer-notes"
                    rows={3}
                    maxLength={500}
                    value={reviewerNotes}
                    onChange={(e) => setReviewerNotes(e.target.value)}
                    placeholder="Record corrections, signature confirmation, or rescan reason..."
                    className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-3 py-2 font-mono text-xs text-white outline-none"
                  />
                </div>
              </div>

              {/* 1-Click HITL Workflow Decision Buttons */}
              <div className="pt-3 border-t border-white/10 space-y-2">
                <button
                  type="button"
                  disabled={decisionBusy}
                  onClick={() => void handleDecision('approve')}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {decisionBusy ? 'Submitting Decision...' : 'Approve & Trigger Next Workflow'}
                </button>
                <button
                  type="button"
                  disabled={decisionBusy}
                  onClick={() => void handleDecision('reject')}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded bg-rose-950/70 hover:bg-rose-900/70 border border-bro-crimson/50 font-mono text-xs font-bold uppercase tracking-wider text-rose-200 cursor-pointer disabled:opacity-50"
                >
                  <XCircle className="w-4 h-4 text-bro-crimson" />
                  Reject &amp; Request Rescan
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
