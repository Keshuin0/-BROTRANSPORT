import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Search,
  Truck,
  Snowflake,
  Layers,
  CheckCircle2,
  AlertTriangle,
  WifiOff,
  Loader2,
  Trash2,
  Building2,
  FileCheck,
  Save,
} from 'lucide-react';
import { CarrierApplicationSchema, type EquipmentType } from '@bro/contracts';
import { saveDraft, getDraft, clearDraft, enqueueOfflineSubmission } from '../../lib/offlineDb';
import { solveOfflinePow } from '../../lib/powWorker';
import { sha256Hex } from '../../lib/ebolCrypto';
import OfflineSyncDrawer from './OfflineSyncDrawer';

const DRAFT_KEY = 'bro_carrier_onboarding_draft_v1';

interface FmcsaCarrierRecordDto {
  dotNumber: string;
  legalName: string;
  dbaName: string | null;
  allowedToOperate: boolean;
  statusCode: string;
  oosDate: string | null;
  commonAuthorityStatus: 'A' | 'I' | 'N';
  contractAuthorityStatus: 'A' | 'I' | 'N';
  brokerAuthorityStatus: 'A' | 'I' | 'N';
  bipdInsuranceOnFileCents: number;
  bipdInsuranceRequiredCents: number;
  cargoInsuranceOnFileCents: number;
  totalPowerUnits: number;
  totalDrivers: number;
  safetyRating: string | null;
  phyCity: string | null;
  phyState: string | null;
  phyCountry: string | null;
  fetchedAt: string;
}

interface FmcsaFraudFindingDto {
  code: string;
  severity?: string;
  detail?: string;
  message?: string;
}

interface FmcsaFraudAssessmentDto {
  approved?: boolean;
  riskLevel: 'LOW' | 'ELEVATED' | 'CRITICAL' | 'PASS' | 'REVIEW' | 'REJECT';
  riskScore?: number;
  flags?: string[];
  findings: FmcsaFraudFindingDto[];
  activeAssignedLoadsCount?: number;
  totalPowerUnits?: number;
  utilizationRatio?: number | null;
}

interface FmcsaVerificationDto {
  verified: boolean;
  reason: string;
  dotNumber: string;
  record: FmcsaCarrierRecordDto | null;
  fraudAssessment: FmcsaFraudAssessmentDto | null;
  cached: boolean;
  source: string;
  error?: string;
}

interface CarrierFormState {
  driverName: string;
  carrierCompanyName: string;
  usdotNumber: string;
  mcNumber: string;
  driverEmail: string;
  driverPhone: string;
  equipmentType: EquipmentType;
  preferredLanes: string;
  hasClass1OrAz: boolean;
  hasCleanAbstract: boolean;
  hasFastCard: boolean;
}

const INITIAL_FORM_STATE: CarrierFormState = {
  driverName: '',
  carrierCompanyName: '',
  usdotNumber: '',
  mcNumber: '',
  driverEmail: '',
  driverPhone: '',
  equipmentType: 'dry_van',
  preferredLanes: '',
  hasClass1OrAz: false,
  hasCleanAbstract: false,
  hasFastCard: false,
};

const EQUIPMENT_DIVISIONS: Array<{
  value: EquipmentType;
  label: string;
  detail: string;
  icon: typeof Truck;
}> = [
  {
    value: 'dry_van',
    label: '53ft Dry Van',
    detail: 'High-cube enclosed commercial freight',
    icon: Truck,
  },
  {
    value: 'reefer',
    label: '53ft Reefer',
    detail: 'FSMA cold-chain & temperature-controlled',
    icon: Snowflake,
  },
  {
    value: 'flatbed',
    label: '53ft Flatbed',
    detail: 'Open-deck steel, lumber & industrial',
    icon: Layers,
  },
];

function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(dollars);
}

function formatAuthorityCode(code: 'A' | 'I' | 'N'): string {
  if (code === 'A') return 'Active';
  if (code === 'I') return 'Inactive';
  return 'None';
}

function formatSafetyRating(rating: string | null): string {
  if (!rating) return 'Unrated';
  const upper = rating.toUpperCase();
  if (upper === 'S') return 'Satisfactory';
  if (upper === 'C') return 'Conditional';
  if (upper === 'U') return 'Unsatisfactory';
  return rating;
}

function deriveFraudBadge(assessment: FmcsaFraudAssessmentDto | null): 'PASS' | 'REVIEW' | 'REJECT' {
  if (!assessment) return 'REVIEW';
  if (assessment.riskLevel === 'REJECT' || assessment.riskLevel === 'CRITICAL') return 'REJECT';
  if (assessment.riskLevel === 'REVIEW' || assessment.riskLevel === 'ELEVATED' || assessment.approved === false) {
    return 'REVIEW';
  }
  return 'PASS';
}

export default function CarrierApplyForm() {
  const [form, setForm] = useState<CarrierFormState>(INITIAL_FORM_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);

  const [verifyingDot, setVerifyingDot] = useState(false);
  const [fmcsaResult, setFmcsaResult] = useState<FmcsaVerificationDto | null>(null);
  const [fmcsaError, setFmcsaError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [powStatus, setPowStatus] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    intakeId: string;
    driverId: string;
    archiveKey?: string;
  } | null>(null);
  const [offlineQueuedInfo, setOfflineQueuedInfo] = useState<{
    queuedAt: number;
    powPrefix: string;
  } | null>(null);

  const saveTimerRef = useRef<number | null>(null);

  const handleVerifyDot = useCallback(async (dotOverride?: string) => {
    const cleanDot = (dotOverride ?? form.usdotNumber).trim();
    setFmcsaError(null);
    setFmcsaResult(null);

    if (!/^\d{4,8}$/.test(cleanDot)) {
      setFmcsaError('USDOT number must be 4 to 8 numeric digits.');
      return;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setFmcsaError('Device is currently offline. Live FMCSA verification will run when signal returns.');
      return;
    }

    setVerifyingDot(true);
    try {
      const res = await fetch(`/api/carriers/verify-dot/${encodeURIComponent(cleanDot)}`);
      const data = (await res.json()) as FmcsaVerificationDto & { error?: string };
      if (!res.ok) {
        setFmcsaError(data.error || `FMCSA lookup failed (HTTP ${res.status}).`);
        return;
      }
      setFmcsaResult(data);
      if (data.record?.legalName) {
        setForm((prev) =>
          prev.carrierCompanyName.trim().length === 0
            ? { ...prev, carrierCompanyName: data.record!.legalName }
            : prev,
        );
      }
    } catch {
      setFmcsaError('Unable to reach FMCSA verification gateway. Check network connection.');
    } finally {
      setVerifyingDot(false);
    }
  }, [form.usdotNumber]);

  // Hydrate saved IndexedDB draft & read optional ?dot= query param on mount
  useEffect(() => {
    let active = true;
    async function init() {
      const saved = await getDraft<Partial<CarrierFormState>>(DRAFT_KEY);
      const urlDot =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('dot')?.trim() ?? ''
          : '';

      if (!active) return;

      const merged: CarrierFormState = {
        ...INITIAL_FORM_STATE,
        ...(saved ?? {}),
        ...(urlDot ? { usdotNumber: urlDot } : {}),
      };
      setForm(merged);
      setHydrated(true);

      if (/^\d{4,8}$/.test(urlDot) && typeof navigator !== 'undefined' && navigator.onLine) {
        void handleVerifyDot(urlDot);
      }
    }
    void init();
    return () => {
      active = false;
    };
    // Run once on mount; handleVerifyDot with explicit dotOverride does not depend on state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced (500ms) IndexedDB draft persistence
  useEffect(() => {
    if (!hydrated) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void saveDraft(DRAFT_KEY, form as unknown as Record<string, unknown>).then(() => {
        setDraftSavedAt(Date.now());
      });
    }, 500);

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [form, hydrated]);

  const updateField = <K extends keyof CarrierFormState>(key: K, value: CarrierFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleClearDraft = async () => {
    await clearDraft(DRAFT_KEY);
    setForm(INITIAL_FORM_STATE);
    setDraftSavedAt(null);
    setFmcsaResult(null);
    setFmcsaError(null);
    setFieldErrors({});
    setSubmitError(null);
    setSuccessInfo(null);
    setOfflineQueuedInfo(null);
  };

  const enqueueWithOfflinePow = async (validData: Record<string, unknown>) => {
    setPowStatus('Border dead-zone detected — solving SHA-256 Proof-of-Work locally...');
    const corePayload = `${String(validData.driverEmail)}:${String(validData.driverPhone)}:${String(validData.equipmentType)}`;
    const payloadHash = await sha256Hex(corePayload);
    const offlinePowToken = await solveOfflinePow(payloadHash);

    await enqueueOfflineSubmission({
      kind: 'carrier_application',
      endpoint: '/api/carriers/apply',
      payload: { ...validData, offlinePowToken },
    });
    await clearDraft(DRAFT_KEY);
    setDraftSavedAt(null);
    setOfflineQueuedInfo({
      queuedAt: Date.now(),
      powPrefix: offlinePowToken.slice(0, 26),
    });
  };

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    setSuccessInfo(null);
    setOfflineQueuedInfo(null);
    setPowStatus(null);
    setFieldErrors({});

    const candidatePayload = {
      driverName: form.driverName.trim(),
      carrierCompanyName: form.carrierCompanyName.trim() || undefined,
      usdotNumber: form.usdotNumber.trim() || undefined,
      mcNumber: form.mcNumber.trim() || undefined,
      driverEmail: form.driverEmail.trim(),
      driverPhone: form.driverPhone.trim(),
      equipmentType: form.equipmentType,
      preferredLanes: form.preferredLanes.trim(),
      hasClass1OrAz: form.hasClass1OrAz,
      hasCleanAbstract: form.hasCleanAbstract,
      hasFastCard: form.hasFastCard,
      dotSafetyCertified: true,
    };

    const parsed = CarrierApplicationSchema.safeParse(candidatePayload);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setSubmitError(parsed.error.issues[0]?.message || 'Please review the highlighted fields.');
      return;
    }

    setSubmitting(true);
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await enqueueWithOfflinePow(parsed.data as unknown as Record<string, unknown>);
        return;
      }

      let res: Response;
      try {
        res = await fetch('/api/carriers/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.data),
        });
      } catch (err) {
        if (err instanceof TypeError) {
          await enqueueWithOfflinePow(parsed.data as unknown as Record<string, unknown>);
          return;
        }
        throw err;
      }

      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        intakeId?: string;
        driverId?: string;
        archiveKey?: string;
        error?: string;
        fmcsaReport?: FmcsaVerificationDto | null;
      };

      if (data.fmcsaReport) {
        setFmcsaResult(data.fmcsaReport);
      }

      if (!res.ok) {
        // Never enqueue 400/403 server rejections (e.g., FMCSA double-brokering reject or validation error)
        setSubmitError(data.error || `Application rejected by compliance gateway (HTTP ${res.status}).`);
        return;
      }

      await clearDraft(DRAFT_KEY);
      setDraftSavedAt(null);
      setSuccessInfo({
        intakeId: data.intakeId ?? 'CONFIRMED',
        driverId: data.driverId ?? '',
        archiveKey: data.archiveKey,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unexpected submission error.');
    } finally {
      setSubmitting(false);
      setPowStatus(null);
    }
  };

  const fraudBadge = fmcsaResult?.fraudAssessment ? deriveFraudBadge(fmcsaResult.fraudAssessment) : null;

  return (
    <div className="w-full max-w-3xl mx-auto space-y-6">
      {/* Header Bar with Offline Sync Drawer */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 sm:p-6 rounded-2xl surface-ceramic border-bro-gold/25">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-bro-gold/10 border border-bro-gold/30 text-xs font-medium text-bro-gold">
            <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>FMCSA Carrier &amp; Commercial Driver Intake</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-display font-bold text-white tracking-tight">
            Partner Capacity Onboarding
          </h2>
          <p className="text-xs sm:text-sm text-slate-300">
            Live US DOT FMCSA authority &amp; double-brokering verification. Offline border dead-zone resilient.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
          <OfflineSyncDrawer />
        </div>
      </div>

      {/* Main Form Card */}
      <form
        onSubmit={handleSubmit}
        noValidate
        className="rounded-2xl surface-ceramic p-5 sm:p-8 space-y-6"
      >
        {/* Draft Status Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <Save className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <span>
              {draftSavedAt
                ? `Local draft saved ${new Date(draftSavedAt).toLocaleTimeString()}`
                : 'Auto-saves locally to IndexedDB (500ms debounce)'}
            </span>
          </div>
          <button
            type="button"
            onClick={handleClearDraft}
            className="min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-white/15 bg-[#060912] text-xs font-medium text-slate-300 hover:text-rose-200 hover:border-rose-500/50 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Clear Draft</span>
          </button>
        </div>

        {/* USDOT Live Verification Block */}
        <div className="p-4 sm:p-5 rounded-2xl bg-[#060912] border border-bro-cyan/30 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="apply-usdot" className="block text-xs font-medium text-slate-300">
                USDOT # (Optional for Company Drivers, Required for Partner Carriers)
              </label>
              <input
                id="apply-usdot"
                type="text"
                inputMode="numeric"
                maxLength={8}
                value={form.usdotNumber}
                onChange={(e) => updateField('usdotNumber', e.target.value.replace(/[^\d]/g, ''))}
                placeholder="e.g. 3849201 (4–8 digit USDOT)"
                className="w-full min-h-[44px] bg-[#0b1120] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan tabular-nums"
              />
              {fieldErrors.usdotNumber && (
                <p className="text-xs font-medium text-rose-300">{fieldErrors.usdotNumber}</p>
              )}
            </div>

            <div className="w-full sm:w-44 space-y-1.5">
              <label htmlFor="apply-mc" className="block text-xs font-medium text-slate-300">
                MC # (Optional)
              </label>
              <input
                id="apply-mc"
                type="text"
                maxLength={12}
                value={form.mcNumber}
                onChange={(e) => updateField('mcNumber', e.target.value.toUpperCase())}
                placeholder="MC1482910"
                className="w-full min-h-[44px] bg-[#0b1120] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>

            <button
              type="button"
              disabled={verifyingDot || form.usdotNumber.trim().length < 4}
              onClick={() => void handleVerifyDot()}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shrink-0"
            >
              {verifyingDot ? (
                <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              ) : (
                <Search className="w-4 h-4 shrink-0" aria-hidden="true" />
              )}
              <span>{verifyingDot ? 'Querying...' : 'Verify USDOT'}</span>
            </button>
          </div>

          {fmcsaError && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-200 text-xs font-medium"
            >
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{fmcsaError}</span>
            </div>
          )}

          {fmcsaResult && (
            <div
              className={`p-4 sm:p-5 rounded-2xl border space-y-3.5 ${
                !fmcsaResult.verified || fraudBadge === 'REJECT'
                  ? 'bg-rose-950/40 border-rose-500/50'
                  : fraudBadge === 'REVIEW'
                    ? 'bg-amber-950/40 border-bro-gold/50'
                    : 'bg-emerald-950/30 border-emerald-500/40'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  {fraudBadge === 'PASS' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                  )}
                  <span className="font-display text-sm font-bold text-white">
                    FMCSA Record — DOT #{fmcsaResult.dotNumber}
                  </span>
                  {fmcsaResult.cached && (
                    <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-xs text-slate-200">
                      Cached 24h
                    </span>
                  )}
                </div>

                {fraudBadge && (
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                      fraudBadge === 'PASS'
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                        : fraudBadge === 'REVIEW'
                          ? 'bg-amber-500/20 border-bro-gold text-amber-200'
                          : 'bg-rose-500/20 border-rose-400 text-rose-200'
                    }`}
                  >
                    Fraud Risk: {fraudBadge}
                  </span>
                )}
              </div>

              {fmcsaResult.record ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="space-y-0.5">
                      <div className="font-display font-bold text-white text-sm">{fmcsaResult.record.legalName}</div>
                      <div className="text-xs text-slate-300">
                        {[fmcsaResult.record.phyCity, fmcsaResult.record.phyState, fmcsaResult.record.phyCountry]
                          .filter(Boolean)
                          .join(', ') || 'Registered Carrier'}
                        {fmcsaResult.record.oosDate ? ` · OOS Date: ${fmcsaResult.record.oosDate}` : ''}
                      </div>
                    </div>
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                        fmcsaResult.record.allowedToOperate
                          ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                          : 'bg-rose-500/20 text-rose-200 border-rose-500/50'
                      }`}
                    >
                      {fmcsaResult.record.allowedToOperate ? 'Allowed to Operate' : 'Not Authorized'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
                    <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10">
                      <div className="text-xs text-slate-400">Authority</div>
                      <div className="font-mono text-xs text-white mt-0.5 font-medium">
                        Com: {formatAuthorityCode(fmcsaResult.record.commonAuthorityStatus)} · Ctr:{' '}
                        {formatAuthorityCode(fmcsaResult.record.contractAuthorityStatus)}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10">
                      <div className="text-xs text-slate-400">Safety Rating</div>
                      <div className="font-mono text-xs font-semibold text-white mt-0.5">
                        {formatSafetyRating(fmcsaResult.record.safetyRating)}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10">
                      <div className="text-xs text-slate-400">Power Units</div>
                      <div className="font-mono text-xs font-semibold text-white tabular-nums mt-0.5">
                        {fmcsaResult.record.totalPowerUnits} trucks · {fmcsaResult.record.totalDrivers} drivers
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10">
                      <div className="text-xs text-slate-400">BIPD Insurance</div>
                      <div className="font-mono text-xs font-semibold text-white tabular-nums mt-0.5">
                        {formatUsdCents(fmcsaResult.record.bipdInsuranceOnFileCents)}
                      </div>
                    </div>
                  </div>

                  {fmcsaResult.fraudAssessment && fmcsaResult.fraudAssessment.findings.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-xs text-rose-200 font-semibold">
                        Audit Findings ({fmcsaResult.fraudAssessment.findings.length}):
                      </div>
                      <ul className="space-y-1.5">
                        {fmcsaResult.fraudAssessment.findings.map((finding, idx) => (
                          <li
                            key={`${finding.code}-${idx}`}
                            className="flex items-start gap-2 text-xs text-rose-100 bg-rose-950/60 border border-rose-500/40 rounded-xl px-3 py-2"
                          >
                            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                            <span>{finding.detail || finding.message || finding.code}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-amber-200">
                  {fmcsaResult.error || `No FMCSA carrier profile returned (${fmcsaResult.reason}).`}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Applicant Identity & Contact */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="apply-legal-name" className="block text-xs font-medium text-slate-300">
              Legal Name *
            </label>
            <input
              id="apply-legal-name"
              type="text"
              required
              value={form.driverName}
              onChange={(e) => updateField('driverName', e.target.value)}
              placeholder="e.g. Liam Gallant"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-gold"
            />
            {fieldErrors.driverName && <p className="text-xs font-medium text-rose-300">{fieldErrors.driverName}</p>}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="apply-company" className="block text-xs font-medium text-slate-300">
              Carrier Company (Optional)
            </label>
            <div className="relative">
              <Building2
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="apply-company"
                type="text"
                value={form.carrierCompanyName}
                onChange={(e) => updateField('carrierCompanyName', e.target.value)}
                placeholder="e.g. Maritime Corridor Carriers Ltd."
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-gold"
              />
            </div>
            {fieldErrors.carrierCompanyName && (
              <p className="text-xs font-medium text-rose-300">{fieldErrors.carrierCompanyName}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="apply-email" className="block text-xs font-medium text-slate-300">
              Email Address *
            </label>
            <input
              id="apply-email"
              type="email"
              required
              autoComplete="email"
              value={form.driverEmail}
              onChange={(e) => updateField('driverEmail', e.target.value)}
              placeholder="driver@carrier.com"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-gold"
            />
            {fieldErrors.driverEmail && <p className="text-xs font-medium text-rose-300">{fieldErrors.driverEmail}</p>}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="apply-phone" className="block text-xs font-medium text-slate-300">
              Phone (10-Digit) *
            </label>
            <input
              id="apply-phone"
              type="tel"
              required
              autoComplete="tel"
              value={form.driverPhone}
              onChange={(e) => updateField('driverPhone', e.target.value)}
              placeholder="902-555-0174"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 font-mono outline-none focus:border-bro-gold tabular-nums"
            />
            {fieldErrors.driverPhone && <p className="text-xs font-medium text-rose-300">{fieldErrors.driverPhone}</p>}
          </div>
        </div>

        {/* Commercial Equipment Division */}
        <fieldset className="space-y-2.5">
          <legend className="text-xs font-medium text-slate-300">
            Commercial Equipment Division *
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {EQUIPMENT_DIVISIONS.map((eq) => {
              const Icon = eq.icon;
              const selected = form.equipmentType === eq.value;
              return (
                <button
                  key={eq.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => updateField('equipmentType', eq.value)}
                  className={`min-h-[44px] p-4 rounded-2xl border text-left transition-colors cursor-pointer space-y-1.5 ${
                    selected
                      ? 'bg-bro-gold/15 border-bro-gold text-white'
                      : 'bg-[#060912] border-white/10 text-slate-300 hover:border-white/30 hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2 font-display text-sm font-semibold">
                    <Icon className={`w-4 h-4 shrink-0 ${selected ? 'text-bro-gold' : 'text-slate-400'}`} aria-hidden="true" />
                    <span>{eq.label}</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">{eq.detail}</p>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Preferred Lanes */}
        <div className="space-y-1.5">
          <label htmlFor="apply-lanes" className="block text-xs font-medium text-slate-300">
            Preferred Commercial Lanes *
          </label>
          <input
            id="apply-lanes"
            type="text"
            required
            value={form.preferredLanes}
            onChange={(e) => updateField('preferredLanes', e.target.value)}
            placeholder="e.g. PEI -> Boston, Moncton -> Montreal, Halifax -> Toronto"
            className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-gold"
          />
          {fieldErrors.preferredLanes && (
            <p className="text-xs font-medium text-rose-300">{fieldErrors.preferredLanes}</p>
          )}
        </div>

        {/* Compliance Declarations */}
        <div className="space-y-3 pt-4 border-t border-white/10">
          <div className="text-xs font-semibold text-slate-300">
            Mandatory Qualification &amp; Cross-Border Declarations
          </div>

          <label
            htmlFor="apply-class1"
            className="min-h-[44px] flex items-start gap-3.5 p-4 rounded-2xl bg-[#060912] border border-white/10 hover:border-bro-gold/40 cursor-pointer transition-colors"
          >
            <input
              id="apply-class1"
              type="checkbox"
              checked={form.hasClass1OrAz}
              onChange={(e) => updateField('hasClass1OrAz', e.target.checked)}
              className="mt-0.5 h-5 w-5 accent-amber-400 rounded cursor-pointer shrink-0"
            />
            <div className="text-xs space-y-1">
              <span className="text-white font-semibold block">
                Valid Class 1 / AZ Commercial Driver License *
              </span>
              <p className="text-slate-300 leading-relaxed">
                Active heavy combination tractor-trailer license in good standing across CA/US jurisdictions.
              </p>
              {fieldErrors.hasClass1OrAz && (
                <p className="text-rose-300 font-medium">{fieldErrors.hasClass1OrAz}</p>
              )}
            </div>
          </label>

          <label
            htmlFor="apply-abstract"
            className="min-h-[44px] flex items-start gap-3.5 p-4 rounded-2xl bg-[#060912] border border-white/10 hover:border-bro-gold/40 cursor-pointer transition-colors"
          >
            <input
              id="apply-abstract"
              type="checkbox"
              checked={form.hasCleanAbstract}
              onChange={(e) => updateField('hasCleanAbstract', e.target.checked)}
              className="mt-0.5 h-5 w-5 accent-amber-400 rounded cursor-pointer shrink-0"
            />
            <div className="text-xs space-y-1">
              <span className="text-white font-semibold block">Clean 3-Year Commercial Driver Abstract *</span>
              <p className="text-slate-300 leading-relaxed">
                Zero major preventable accidents, DUI convictions, or unresolved FMCSA/NSC safety orders.
              </p>
              {fieldErrors.hasCleanAbstract && (
                <p className="text-rose-300 font-medium">{fieldErrors.hasCleanAbstract}</p>
              )}
            </div>
          </label>

          <label
            htmlFor="apply-fast"
            className="min-h-[44px] flex items-start gap-3.5 p-4 rounded-2xl bg-[#060912] border border-white/10 hover:border-bro-cyan/40 cursor-pointer transition-colors"
          >
            <input
              id="apply-fast"
              type="checkbox"
              checked={form.hasFastCard}
              onChange={(e) => updateField('hasFastCard', e.target.checked)}
              className="mt-0.5 h-5 w-5 accent-cyan-400 rounded cursor-pointer shrink-0"
            />
            <div className="text-xs space-y-1">
              <span className="text-white font-semibold block">FAST Card Holder (Optional)</span>
              <p className="text-slate-300 leading-relaxed">
                CBSA / CBP Free and Secure Trade trusted driver credential for expedited border lanes.
              </p>
            </div>
          </label>
        </div>

        {/* Status Banners */}
        {powStatus && (
          <div
            aria-live="polite"
            className="flex items-center gap-2.5 p-3.5 rounded-xl bg-amber-950/60 border border-bro-gold/50 text-bro-gold text-xs font-medium"
          >
            <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
            <span>{powStatus}</span>
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 p-4 rounded-2xl bg-rose-950/70 border border-rose-500 text-rose-100 text-xs"
          >
            <ShieldAlert className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <div className="font-semibold text-rose-200 mb-0.5">Submission Rejected</div>
              <p>{submitError}</p>
            </div>
          </div>
        )}

        {successInfo && (
          <div
            role="status"
            aria-live="polite"
            className="p-4 rounded-2xl bg-emerald-950/60 border border-emerald-500/50 text-emerald-100 space-y-2.5"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
              <FileCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Application Verified &amp; Archived</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 font-mono text-xs">
              <div className="p-3 rounded-xl bg-black/35 border border-white/10">
                <span className="text-slate-300 block text-xs">Intake Reference</span>
                <span className="text-white font-bold">{successInfo.intakeId}</span>
              </div>
              {successInfo.driverId && (
                <div className="p-3 rounded-xl bg-black/35 border border-white/10">
                  <span className="text-slate-300 block text-xs">Driver Record ID</span>
                  <span className="text-white font-bold">{successInfo.driverId}</span>
                </div>
              )}
            </div>
            <p className="text-xs text-emerald-100 leading-relaxed">
              Our Safety &amp; Compliance Desk has logged your packet. Once approved, you will receive Driver Portal access.
            </p>
          </div>
        )}

        {offlineQueuedInfo && (
          <div
            role="status"
            aria-live="polite"
            className="p-4 rounded-2xl bg-amber-950/60 border border-bro-gold text-amber-100 space-y-1.5"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-bro-gold">
              <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Queued Offline with Cryptographic PoW</span>
            </div>
            <p className="text-xs text-amber-100/90 leading-relaxed">
              Your application was sealed with a SHA-256 Hashcash proof ({offlineQueuedInfo.powPrefix}…) and stored in
              the Offline Sync Vault at {new Date(offlineQueuedInfo.queuedAt).toLocaleTimeString()}. It will sync
              automatically once signal returns.
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full min-h-[48px] flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-bro-gold hover:bg-amber-300 text-black text-sm font-semibold disabled:opacity-50 transition-colors cursor-pointer"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              <span>{powStatus ? 'Computing Offline PoW...' : 'Submitting Onboarding Packet...'}</span>
            </>
          ) : (
            <>
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Submit Carrier &amp; Driver Application</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
