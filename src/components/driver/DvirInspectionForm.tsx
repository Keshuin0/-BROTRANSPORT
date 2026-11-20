import React, { useState, useEffect } from 'react';
import {
  ClipboardCheck,
  AlertTriangle,
  ShieldAlert,
  CheckCircle2,
  WifiOff,
  Loader2,
  Lock,
  Wrench,
} from 'lucide-react';
import { DvirSubmitSchema, type DvirSubmitInput } from '@bro/contracts';
import { enqueueOfflineSubmission } from '../../lib/offlineDb';

type DvirKey = DvirSubmitInput['checklist'][number]['key'];

export interface DvirEquipmentUnit {
  id: string;
  unitNumber: string;
  type: 'tractor' | 'dry_van' | 'reefer' | 'flatbed';
  plate?: string;
  status?: 'active' | 'maintenance' | 'out_of_service';
}

export interface DvirInspectionFormProps {
  fleetUnits?: DvirEquipmentUnit[];
  defaultTractorId?: string;
  defaultTrailerId?: string;
  defaultDriverName?: string;
  onSubmitted?: (result: {
    dvirId?: string;
    equipmentLockedOutOfService?: boolean;
    queuedOffline?: boolean;
  }) => void;
}

const CHECKLIST_DEFINITIONS: Array<{ key: DvirKey; label: string; regulation: string }> = [
  { key: 'service_brakes', label: 'Service Brakes & Air Lines', regulation: 'FMCSA §396.11 / NSC Std 13' },
  { key: 'parking_brake', label: 'Parking / Spring Brake', regulation: 'Air Pressure & Hold Check' },
  { key: 'steering', label: 'Steering Mechanism & Column', regulation: 'Free Play & Power Assist' },
  { key: 'lighting_reflectors', label: 'Lighting Devices & Reflectors', regulation: 'Headlights, Clearance, ABS Lamp' },
  { key: 'tires_tpms', label: 'Tires, Wheels, Rims & TPMS', regulation: 'Tread Depth, Lug Nuts & PSI' },
  { key: 'horn', label: 'Air & Electric Horn', regulation: 'Audible Warning Signal' },
  { key: 'mirrors', label: 'Windshield, Wipers & Mirrors', regulation: 'Unobstructed Visibility' },
  { key: 'coupling_fifth_wheel', label: 'Coupling Devices & Fifth Wheel', regulation: 'Locking Jaws, Kingpin & Chains' },
  { key: 'suspension_axles', label: 'Suspension, Axles & Frame', regulation: 'Airbags, Leaf Springs & U-Bolts' },
  { key: 'exhaust_system', label: 'Exhaust & Aftertreatment', regulation: 'No Leaks Under Cab' },
  { key: 'reefer_unit', label: 'Reefer Unit & Temp Recorder', regulation: 'Setpoint, Fuel & Chute (if Reefer)' },
  { key: 'cargo_securement', label: 'Cargo Securement, Doors & Seals', regulation: 'Straps, Chains, Locks & Seals' },
];

interface ChecklistEntry {
  key: DvirKey;
  status: 'pass' | 'defect';
  notes: string;
}

function buildDefaultChecklist(): ChecklistEntry[] {
  return CHECKLIST_DEFINITIONS.map((item) => ({
    key: item.key,
    status: 'pass',
    notes: '',
  }));
}

export default function DvirInspectionForm({
  fleetUnits = [],
  defaultTractorId = '',
  defaultTrailerId = '',
  defaultDriverName = '',
  onSubmitted,
}: DvirInspectionFormProps) {
  const tractors = fleetUnits.filter((u) => u.type === 'tractor');
  const trailers = fleetUnits.filter((u) => u.type !== 'tractor');

  const [inspectionType, setInspectionType] = useState<'pre_trip' | 'post_trip'>('pre_trip');
  const [tractorId, setTractorId] = useState<string>(defaultTractorId || tractors[0]?.id || '');
  const [trailerId, setTrailerId] = useState<string>(defaultTrailerId || trailers[0]?.id || '');
  const [odometerKm, setOdometerKm] = useState<string>('');
  const [checklist, setChecklist] = useState<ChecklistEntry[]>(buildDefaultChecklist);
  const [safeToOperate, setSafeToOperate] = useState<boolean>(true);
  const [driverSignatureName, setDriverSignatureName] = useState<string>(defaultDriverName);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultBanner, setResultBanner] = useState<{
    dvirId: string;
    defectsFound: boolean;
    equipmentLockedOutOfService: boolean;
  } | null>(null);
  const [offlineQueued, setOfflineQueued] = useState(false);

  useEffect(() => {
    if (!tractorId && (defaultTractorId || tractors[0]?.id)) {
      setTractorId(defaultTractorId || tractors[0]?.id || '');
    }
  }, [defaultTractorId, tractors, tractorId]);

  useEffect(() => {
    if (!trailerId && defaultTrailerId) {
      setTrailerId(defaultTrailerId);
    }
  }, [defaultTrailerId, trailerId]);

  useEffect(() => {
    if (!driverSignatureName && defaultDriverName) {
      setDriverSignatureName(defaultDriverName);
    }
  }, [defaultDriverName, driverSignatureName]);

  const defectCount = checklist.filter((item) => item.status === 'defect').length;

  const setItemStatus = (key: DvirKey, status: 'pass' | 'defect') => {
    setChecklist((prev) => prev.map((item) => (item.key === key ? { ...item, status } : item)));
  };

  const setItemNotes = (key: DvirKey, notes: string) => {
    setChecklist((prev) => prev.map((item) => (item.key === key ? { ...item, notes } : item)));
  };

  const markAllPass = () => {
    setChecklist(buildDefaultChecklist());
    setSafeToOperate(true);
  };

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setResultBanner(null);
    setOfflineQueued(false);

    const parsedOdo = Number(odometerKm);
    if (!odometerKm.trim() || !Number.isInteger(parsedOdo) || parsedOdo < 0) {
      setErrorMsg('Enter a valid integer odometer reading in kilometers.');
      return;
    }

    const candidatePayload = {
      tractorId: tractorId.trim(),
      trailerId: trailerId.trim() || undefined,
      inspectionType,
      odometerKm: parsedOdo,
      checklist: checklist.map((item) => ({
        key: item.key,
        status: item.status,
        ...(item.notes.trim() ? { notes: item.notes.trim() } : {}),
      })),
      safeToOperate,
      driverSignatureName: driverSignatureName.trim(),
    };

    const parsed = DvirSubmitSchema.safeParse(candidatePayload);
    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message || 'Complete all required DVIR fields before signing.');
      return;
    }

    setSubmitting(true);
    try {
      const queueOffline = async () => {
        await enqueueOfflineSubmission({
          kind: 'dvir',
          endpoint: '/api/driver/dvir',
          payload: parsed.data as unknown as Record<string, unknown>,
        });
        setOfflineQueued(true);
        onSubmitted?.({ queuedOffline: true, equipmentLockedOutOfService: !parsed.data.safeToOperate });
      };

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueOffline();
        return;
      }

      let res: Response;
      try {
        res = await fetch('/api/driver/dvir', {
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
        dvirId?: string;
        defectsFound?: boolean;
        equipmentLockedOutOfService?: boolean;
        error?: string;
      };

      if (!res.ok) {
        setErrorMsg(data.error || `DVIR submission failed (HTTP ${res.status}).`);
        return;
      }

      setResultBanner({
        dvirId: data.dvirId ?? 'recorded',
        defectsFound: Boolean(data.defectsFound),
        equipmentLockedOutOfService: Boolean(data.equipmentLockedOutOfService),
      });
      onSubmitted?.({
        dvirId: data.dvirId,
        equipmentLockedOutOfService: Boolean(data.equipmentLockedOutOfService),
        queuedOffline: false,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to submit DVIR inspection.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg bg-bro-steel/60 border border-white/10 p-5 sm:p-6 space-y-6"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-bro-gold">
            <ClipboardCheck className="w-4 h-4" />
            <span>12-Point FMCSA / NSC Schedule 1 DVIR</span>
          </div>
          <p className="text-xs text-slate-400">
            Mandatory commercial vehicle safety inspection before dispatch and after trip completion.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded bg-bro-obsidian/80 border border-white/10 font-mono text-[11px]">
          <button
            type="button"
            onClick={() => setInspectionType('pre_trip')}
            className={`px-3 py-1.5 rounded uppercase font-bold cursor-pointer transition-colors ${
              inspectionType === 'pre_trip' ? 'bg-bro-cyan text-black' : 'text-slate-400 hover:text-white'
            }`}
          >
            Pre-Trip
          </button>
          <button
            type="button"
            onClick={() => setInspectionType('post_trip')}
            className={`px-3 py-1.5 rounded uppercase font-bold cursor-pointer transition-colors ${
              inspectionType === 'post_trip' ? 'bg-bro-gold text-black' : 'text-slate-400 hover:text-white'
            }`}
          >
            Post-Trip
          </button>
        </div>
      </div>

      {/* Equipment & Odometer */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="dvir-tractor" className="block font-mono text-[11px] uppercase text-slate-300">
            Tractor Unit *
          </label>
          {tractors.length > 0 ? (
            <select
              id="dvir-tractor"
              required
              value={tractorId}
              onChange={(e) => setTractorId(e.target.value)}
              className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm text-white outline-none focus:border-bro-gold"
            >
              <option value="">Select Tractor...</option>
              {tractors.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.unitNumber} {u.plate ? `(${u.plate})` : ''}
                  {u.status === 'out_of_service' ? ' [OUT OF SERVICE]' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="dvir-tractor"
              type="text"
              required
              value={tractorId}
              onChange={(e) => setTractorId(e.target.value)}
              placeholder="e.g. eq_trc_101"
              className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm font-mono text-white outline-none focus:border-bro-gold"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="dvir-trailer" className="block font-mono text-[11px] uppercase text-slate-300">
            Trailer Unit (Optional)
          </label>
          {trailers.length > 0 ? (
            <select
              id="dvir-trailer"
              value={trailerId}
              onChange={(e) => setTrailerId(e.target.value)}
              className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm text-white outline-none focus:border-bro-gold"
            >
              <option value="">Bobtail / No Trailer</option>
              {trailers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.unitNumber} · {u.type.replace('_', ' ').toUpperCase()}
                  {u.status === 'out_of_service' ? ' [OUT OF SERVICE]' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="dvir-trailer"
              type="text"
              value={trailerId}
              onChange={(e) => setTrailerId(e.target.value)}
              placeholder="Optional trailer ID"
              className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm font-mono text-white outline-none focus:border-bro-gold"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="dvir-odometer" className="block font-mono text-[11px] uppercase text-slate-300">
            Odometer (km) *
          </label>
          <input
            id="dvir-odometer"
            type="number"
            inputMode="numeric"
            min={0}
            max={5000000}
            required
            value={odometerKm}
            onChange={(e) => setOdometerKm(e.target.value)}
            placeholder="e.g. 248510"
            className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-2.5 text-sm font-mono text-white outline-none focus:border-bro-gold tabular-nums"
          />
        </div>
      </div>

      {/* 12-Point Checklist */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-xs uppercase text-slate-300">
            Inspection Points ({12 - defectCount}/12 Pass ·{' '}
            <span className={defectCount > 0 ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
              {defectCount} Defect{defectCount === 1 ? '' : 's'}
            </span>
            )
          </div>
          <button
            type="button"
            onClick={markAllPass}
            className="px-2.5 py-1 rounded border border-emerald-500/30 bg-emerald-950/40 text-emerald-300 font-mono text-[10px] uppercase hover:bg-emerald-950/70 cursor-pointer"
          >
            Reset All to Pass
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {CHECKLIST_DEFINITIONS.map((def, index) => {
            const entry = checklist[index];
            const isDefect = entry.status === 'defect';
            return (
              <div
                key={def.key}
                className={`p-3.5 rounded-lg border space-y-2.5 transition-colors ${
                  isDefect
                    ? 'bg-rose-950/40 border-rose-500/50'
                    : 'bg-bro-obsidian/70 border-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      <span className="font-mono text-[10px] text-slate-400 mr-1.5 tabular-nums">
                        {String(index + 1).padStart(2, '0')}.
                      </span>
                      {def.label}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400">{def.regulation}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      aria-pressed={!isDefect}
                      onClick={() => setItemStatus(def.key, 'pass')}
                      className={`px-2.5 py-1.5 rounded font-mono text-[10px] font-bold uppercase cursor-pointer transition-colors ${
                        !isDefect
                          ? 'bg-emerald-500/20 border border-emerald-400 text-emerald-300'
                          : 'bg-bro-steel/60 border border-white/10 text-slate-400 hover:text-white'
                      }`}
                    >
                      Pass
                    </button>
                    <button
                      type="button"
                      aria-pressed={isDefect}
                      onClick={() => setItemStatus(def.key, 'defect')}
                      className={`px-2.5 py-1.5 rounded font-mono text-[10px] font-bold uppercase cursor-pointer transition-colors ${
                        isDefect
                          ? 'bg-rose-500/30 border border-rose-400 text-rose-100'
                          : 'bg-bro-steel/60 border border-white/10 text-slate-400 hover:text-rose-200'
                      }`}
                    >
                      Defect
                    </button>
                  </div>
                </div>

                {isDefect && (
                  <input
                    type="text"
                    maxLength={300}
                    value={entry.notes}
                    onChange={(e) => setItemNotes(def.key, e.target.value)}
                    placeholder={`Describe ${def.label.toLowerCase()} defect details...`}
                    aria-label={`${def.label} defect notes`}
                    className="w-full bg-bro-obsidian/90 border border-rose-500/40 rounded px-2.5 py-1.5 text-xs text-rose-100 placeholder:text-rose-300/50 outline-none focus:border-rose-400"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Safe to Operate Toggle & Mandatory OUT OF SERVICE Lock Warning */}
      <div
        className={`p-4 rounded-lg border-2 space-y-3 ${
          safeToOperate
            ? 'bg-bro-obsidian/80 border-emerald-500/40'
            : 'bg-rose-950/70 border-bro-crimson'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-white">
              {safeToOperate ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : (
                <Lock className="w-4 h-4 text-bro-crimson" />
              )}
              <span>Vehicle Safety Certification</span>
            </div>
            <p className="text-xs text-slate-300">
              Certify whether the inspected tractor & trailer are mechanically safe to operate on public highways.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              aria-pressed={safeToOperate}
              onClick={() => setSafeToOperate(true)}
              className={`px-3.5 py-2 rounded font-mono text-xs font-bold uppercase cursor-pointer border transition-colors ${
                safeToOperate
                  ? 'bg-emerald-500 text-black border-emerald-400'
                  : 'bg-bro-obsidian/80 text-slate-300 border-white/15 hover:border-emerald-400'
              }`}
            >
              Safe to Operate
            </button>
            <button
              type="button"
              aria-pressed={!safeToOperate}
              onClick={() => setSafeToOperate(false)}
              className={`px-3.5 py-2 rounded font-mono text-xs font-bold uppercase cursor-pointer border transition-colors ${
                !safeToOperate
                  ? 'bg-bro-crimson text-white border-rose-400'
                  : 'bg-bro-obsidian/80 text-rose-300 border-rose-500/40 hover:border-bro-crimson'
              }`}
            >
              Unsafe (Lock OOS)
            </button>
          </div>
        </div>

        <div
          className={`flex items-start gap-2.5 p-3 rounded font-mono text-xs ${
            safeToOperate
              ? 'bg-amber-950/40 border border-bro-gold/40 text-amber-200'
              : 'bg-black/40 border border-rose-500 text-rose-100 font-bold'
          }`}
        >
          <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${safeToOperate ? 'text-bro-gold' : 'text-bro-crimson'}`} />
          <span>
            WARNING: Marking this unit UNSAFE immediately locks the tractor (and attached trailer) OUT OF SERVICE in
            Dispatch & Telematics until a certified mechanic logs repairs and clears the unit.
          </span>
        </div>
      </div>

      {/* Driver Legal Signature */}
      <div className="space-y-1.5">
        <label htmlFor="dvir-signature" className="block font-mono text-[11px] uppercase text-slate-300">
          Driver Electronic Signature (Type Full Legal Name) *
        </label>
        <input
          id="dvir-signature"
          type="text"
          required
          minLength={2}
          value={driverSignatureName}
          onChange={(e) => setDriverSignatureName(e.target.value)}
          placeholder="e.g. Liam Gallant"
          className="w-full bg-bro-obsidian/90 border border-white/15 rounded px-3 py-3 text-sm font-mono text-white outline-none focus:border-bro-gold"
        />
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3.5 rounded bg-rose-950/70 border border-rose-500/50 text-rose-200 font-mono text-xs"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {resultBanner && (
        <div
          role="status"
          aria-live="polite"
          className={`p-4 rounded border space-y-1.5 font-mono text-xs ${
            resultBanner.equipmentLockedOutOfService
              ? 'bg-rose-950/70 border-bro-crimson text-rose-100'
              : 'bg-emerald-950/60 border-emerald-500/50 text-emerald-100'
          }`}
        >
          <div className="flex items-center gap-2 font-bold uppercase">
            {resultBanner.equipmentLockedOutOfService ? (
              <>
                <Wrench className="w-4 h-4 text-bro-crimson" />
                <span>DVIR Logged — Unit Locked OUT OF SERVICE</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>DVIR Certified & Logged ({inspectionType === 'pre_trip' ? 'Pre-Trip' : 'Post-Trip'})</span>
              </>
            )}
          </div>
          <div className="text-[11px]">
            Record ID: {resultBanner.dvirId} · Defects Recorded: {resultBanner.defectsFound ? 'Yes' : 'None'}
          </div>
        </div>
      )}

      {offlineQueued && (
        <div
          role="status"
          aria-live="polite"
          className="p-3.5 rounded bg-amber-950/60 border border-bro-gold text-amber-100 font-mono text-xs space-y-1"
        >
          <div className="flex items-center gap-2 font-bold text-bro-gold uppercase">
            <WifiOff className="w-4 h-4" />
            <span>DVIR Saved to Offline Sync Vault</span>
          </div>
          <p className="text-[11px]">
            Inspection signed locally while offline and queued for automatic upload upon signal recovery.
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className={`w-full flex items-center justify-center gap-2 py-3.5 rounded font-mono text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-colors cursor-pointer ${
          safeToOperate
            ? 'bg-bro-gold hover:bg-amber-400 text-black'
            : 'bg-bro-crimson hover:bg-rose-600 text-white'
        }`}
      >
        {submitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Signing & Recording DVIR...</span>
          </>
        ) : (
          <>
            <ClipboardCheck className="w-4 h-4" />
            <span>
              {safeToOperate ? 'Sign & Certify DVIR (Safe to Operate)' : 'Sign DVIR & Lock Equipment OUT OF SERVICE'}
            </span>
          </>
        )}
      </button>
    </form>
  );
}
