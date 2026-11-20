import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  Cpu,
  Gauge,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Thermometer,
  Truck,
  Wrench,
  X,
} from 'lucide-react';
import {
  computeWeibullSurvival,
  type EquipmentType,
  type WeibullSurvivalResult,
} from '@bro/contracts';
import { BroWsClient } from '../../lib/wsClient';

interface EquipmentRow {
  id: string;
  unitNumber: string;
  type: 'tractor' | 'dry_van' | 'reefer' | 'flatbed';
  vin: string;
  plate: string;
  jurisdiction: string;
  gvwrKg: number;
  operatingHours: number;
  annualInspectionExpiry: number;
  status: 'active' | 'maintenance' | 'out_of_service';
}

interface DriverRow {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  equipmentDivision: EquipmentType;
  licenseNumber: string | null;
  licenseExpiry: number | null;
  medicalCardExpiry: number | null;
  fastCardNumber: string | null;
  status: string;
}

interface DvirRow {
  id: string;
  driverId: string;
  tractorId: string;
  trailerId: string | null;
  inspectionType: 'pre_trip' | 'post_trip';
  odometerKm: number;
  checklistJson: string;
  defectsFound: boolean;
  safeToOperate: boolean;
  driverSignatureName: string;
  signedAt: number;
  mechanicClearedBy: string | null;
  mechanicClearedAt: number | null;
}

interface TelematicsRow {
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
  vibrationHz: number | null;
  weibullHazard: number | null;
  failureRiskPct: number | null;
  rulHours: number | null;
  recordedAt: number;
}

interface ExpiryAlert {
  id: string;
  entityType: 'Driver Medical Card' | 'Driver CDL/Class 1' | 'Equipment Annual DOT/NSC';
  entityLabel: string;
  expiryMs: number;
  daysLeft: number;
}

function formatDateIso(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDefectCount(checklistJson: string): number {
  try {
    const items = JSON.parse(checklistJson) as Array<{ status?: string }>;
    return items.filter((i) => i.status === 'defect').length;
  } catch {
    return 0;
  }
}

export default function FleetSafetyDesk() {
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [dvirs, setDvirs] = useState<DvirRow[]>([]);
  const [telematics, setTelematics] = useState<TelematicsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyDvirId, setBusyDvirId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Weibull-Cox Digital Twin State
  const [twinMode, setTwinMode] = useState<'LIVE_D1_TELEMETRY' | 'DIGITAL_TWIN_SANDBOX'>('LIVE_D1_TELEMETRY');
  const [selectedUnitId, setSelectedUnitId] = useState<string>('');

  // Sandbox sliders (strictly deterministic covariates)
  const [sandboxSetpointC, setSandboxSetpointC] = useState(4.0);
  const [sandboxTempDevC, setSandboxTempDevC] = useState(0.1);
  const [sandboxTpmsDropPsi, setSandboxTpmsDropPsi] = useState(3);
  const [sandboxVibHz, setSandboxVibHz] = useState(12.4);
  const [sandboxHours, setSandboxHours] = useState(1840);

  const fetchFleet = useCallback(async () => {
    try {
      const res = await fetch('/api/ops/fleet');
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ kind: 'error', text: err.error || `Unable to load fleet safety data (HTTP ${res.status}).` });
        return;
      }
      const data = (await res.json()) as {
        equipment: EquipmentRow[];
        drivers: DriverRow[];
        dvirs: DvirRow[];
        telematics: TelematicsRow[];
      };
      setEquipment(data.equipment || []);
      setDrivers(data.drivers || []);
      setDvirs(data.dvirs || []);
      setTelematics(data.telematics || []);

      setSelectedUnitId((prev) => {
        if (prev && data.equipment.some((e) => e.id === prev)) return prev;
        // Prefer first unit with telematics data if available
        const firstTelId = data.telematics?.[0]?.equipmentId;
        if (firstTelId && data.equipment.some((e) => e.id === firstTelId)) return firstTelId;
        return data.equipment?.[0]?.id ?? '';
      });
    } catch {
      setBanner({ kind: 'error', text: 'Network error fetching Fleet & Safety desk.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFleet();
  }, [fetchFleet]);

  useEffect(() => {
    const client = new BroWsClient('ops:all', (msg) => {
      if (msg.type === 'TELEMATICS_ALERT') {
        void fetchFleet();
      }
    });
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [fetchFleet]);

  const selectedUnit = equipment.find((e) => e.id === selectedUnitId) || equipment[0] || null;
  const latestUnitTel = useMemo(() => {
    if (!selectedUnit) return null;
    return telematics.find((t) => t.equipmentId === selectedUnit.id) || null;
  }, [selectedUnit, telematics]);

  // Sync baseline into sandbox whenever selected unit changes
  const syncSandboxFromLive = useCallback(() => {
    const hours = selectedUnit?.operatingHours ?? 2000;
    const setpoint = latestUnitTel?.setpointC ?? 4.0;
    const tempDev =
      latestUnitTel?.reeferTempC !== null &&
      latestUnitTel?.reeferTempC !== undefined &&
      latestUnitTel?.setpointC !== null &&
      latestUnitTel?.setpointC !== undefined
        ? Number(Math.abs(latestUnitTel.reeferTempC - latestUnitTel.setpointC).toFixed(1))
        : 0.1;
    const tpmsDrop =
      latestUnitTel?.tpmsPsi !== null && latestUnitTel?.tpmsPsi !== undefined
        ? Math.max(0, Math.round(Math.abs(105 - latestUnitTel.tpmsPsi)))
        : 0;
    const vib = latestUnitTel?.vibrationHz ?? 12.2;

    setSandboxSetpointC(setpoint);
    setSandboxTempDevC(tempDev);
    setSandboxTpmsDropPsi(tpmsDrop);
    setSandboxVibHz(vib);
    setSandboxHours(hours);
  }, [selectedUnit, latestUnitTel]);

  useEffect(() => {
    syncSandboxFromLive();
  }, [syncSandboxFromLive]);

  // Effective covariates depending on mode (guaranteed synced between display and Weibull math)
  const effectiveCovariates = useMemo(() => {
    if (twinMode === 'LIVE_D1_TELEMETRY') {
      const setpointC = latestUnitTel?.setpointC ?? 4.0;
      const actualTempC = latestUnitTel?.reeferTempC ?? setpointC;
      const tempDeviationC = Number(Math.abs(actualTempC - setpointC).toFixed(2));
      const tpmsPsi = latestUnitTel?.tpmsPsi ?? 105;
      const tpmsDeviationPsi = Math.abs(105 - tpmsPsi);
      const vibrationHz = latestUnitTel?.vibrationHz ?? 12.2;
      const operatingHours = selectedUnit?.operatingHours ?? 1840;
      return {
        setpointC,
        actualTempC,
        tempDeviationC,
        tpmsPsi,
        tpmsDeviationPsi,
        vibrationHz,
        operatingHours,
        doorClosed: latestUnitTel?.doorClosed ?? true,
        axleWeightKg: latestUnitTel?.axleWeightKg ?? null,
      };
    }

    return {
      setpointC: sandboxSetpointC,
      actualTempC: Number((sandboxSetpointC + sandboxTempDevC).toFixed(1)),
      tempDeviationC: sandboxTempDevC,
      tpmsPsi: Math.max(40, 105 - sandboxTpmsDropPsi),
      tpmsDeviationPsi: sandboxTpmsDropPsi,
      vibrationHz: sandboxVibHz,
      operatingHours: sandboxHours,
      doorClosed: true,
      axleWeightKg: latestUnitTel?.axleWeightKg ?? 31400,
    };
  }, [
    twinMode,
    latestUnitTel,
    selectedUnit,
    sandboxSetpointC,
    sandboxTempDevC,
    sandboxTpmsDropPsi,
    sandboxVibHz,
    sandboxHours,
  ]);

  // Real deterministic Weibull-Cox survival calculation from @bro/contracts
  const weibull: WeibullSurvivalResult = useMemo(
    () =>
      computeWeibullSurvival({
        operatingHours: effectiveCovariates.operatingHours,
        tempDeviationC: effectiveCovariates.tempDeviationC,
        tpmsDeviationPsi: effectiveCovariates.tpmsDeviationPsi,
        vibrationHz: effectiveCovariates.vibrationHz,
      }),
    [effectiveCovariates],
  );

  // Deterministic SVG survival curve points S(t | z) for t in [0..10,000h]
  const survivalCurvePath = useMemo(() => {
    const pts: string[] = [];
    const maxT = 10000;
    const width = 320;
    const height = 100;
    for (let i = 0; i <= 25; i++) {
      const t = Math.max(1, Math.round((i / 25) * maxT));
      const res = computeWeibullSurvival({
        operatingHours: t,
        tempDeviationC: effectiveCovariates.tempDeviationC,
        tpmsDeviationPsi: effectiveCovariates.tpmsDeviationPsi,
        vibrationHz: effectiveCovariates.vibrationHz,
      });
      const x = (t / maxT) * width;
      const y = height - res.survivalProbability * (height - 10) - 5;
      pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }, [effectiveCovariates]);

  const currentMarkerX = Math.min(320, (effectiveCovariates.operatingHours / 10000) * 320);
  const currentMarkerY = 100 - weibull.survivalProbability * 90 - 5;

  // 30-Day Compliance Expiry Watchdog
  const complianceAlerts = useMemo<ExpiryAlert[]>(() => {
    const now = Date.now();
    const horizon30d = now + 30 * 86_400_000;
    const alerts: ExpiryAlert[] = [];

    for (const d of drivers) {
      if (d.medicalCardExpiry && d.medicalCardExpiry < horizon30d) {
        alerts.push({
          id: `med-${d.id}`,
          entityType: 'Driver Medical Card',
          entityLabel: d.fullName,
          expiryMs: d.medicalCardExpiry,
          daysLeft: Math.ceil((d.medicalCardExpiry - now) / 86_400_000),
        });
      }
      if (d.licenseExpiry && d.licenseExpiry < horizon30d) {
        alerts.push({
          id: `cdl-${d.id}`,
          entityType: 'Driver CDL/Class 1',
          entityLabel: d.fullName,
          expiryMs: d.licenseExpiry,
          daysLeft: Math.ceil((d.licenseExpiry - now) / 86_400_000),
        });
      }
    }

    for (const eq of equipment) {
      if (eq.annualInspectionExpiry < horizon30d) {
        alerts.push({
          id: `insp-${eq.id}`,
          entityType: 'Equipment Annual DOT/NSC',
          entityLabel: `${eq.unitNumber} (${eq.plate})`,
          expiryMs: eq.annualInspectionExpiry,
          daysLeft: Math.ceil((eq.annualInspectionExpiry - now) / 86_400_000),
        });
      }
    }

    return alerts.sort((a, b) => a.daysLeft - b.daysLeft);
  }, [drivers, equipment]);

  const handleMechanicClear = async (dvir: DvirRow) => {
    setBusyDvirId(dvir.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/fleet/dvir/${encodeURIComponent(dvir.id)}/clear`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || `Clearance rejected (HTTP ${res.status}).` });
      } else {
        setBanner({
          kind: 'success',
          text: `DVIR ${dvir.id.slice(0, 12)} mechanic clearance signed — linked equipment unlocked to ACTIVE.`,
        });
        await fetchFleet();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error clearing Out-Of-Service lock.' });
    } finally {
      setBusyDvirId(null);
    }
  };

  const driverMap = new Map(drivers.map((d) => [d.id, d]));
  const equipMap = new Map(equipment.map((e) => [e.id, e]));

  const riskBadgeClass =
    weibull.riskTier === 'CRITICAL'
      ? 'bg-bro-crimson/20 text-bro-crimson border-bro-crimson/50'
      : weibull.riskTier === 'ELEVATED'
        ? 'bg-bro-gold/15 text-bro-gold border-bro-gold/45'
        : 'bg-emerald-950/70 text-emerald-300 border-emerald-500/45';

  const riskBarColor =
    weibull.riskTier === 'CRITICAL'
      ? 'bg-bro-crimson'
      : weibull.riskTier === 'ELEVATED'
        ? 'bg-bro-gold'
        : 'bg-bro-cyan';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-cyan">
            MODULE 05 // WEIBULL-COX DIGITAL TWIN · DVIR SAFETY LOCK · NSC/DOT WATCHDOG
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            Fleet Safety &amp; Predictive Maintenance Desk
          </h1>
        </div>
        <button
          type="button"
          onClick={() => void fetchFleet()}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 font-mono text-xs text-white cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Fleet Telemetry
        </button>
      </div>

      {/* Inline Feedback Banner */}
      {banner && (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border font-mono text-xs ${
            banner.kind === 'error'
              ? 'bg-rose-950/50 border-bro-crimson/40 text-rose-200'
              : 'bg-emerald-950/50 border-emerald-500/40 text-emerald-200'
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Interactive Weibull-Cox Predictive Maintenance Digital Twin */}
      <section
        aria-label="Weibull-Cox Predictive Maintenance Digital Twin"
        className="glass-panel rounded-lg border border-bro-cyan/30 p-5 space-y-5"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-bro-cyan shrink-0" />
            <div>
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                Weibull-Cox Proportional Hazards Digital Twin
              </h2>
              <p className="font-mono text-[10px] text-slate-400">
                S(t|z) = exp(-(t/η)^k · exp(βᵀz)) · Real deterministic engine from @bro/contracts
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Select fleet unit for Weibull-Cox analysis"
              value={selectedUnit?.id || ''}
              onChange={(e) => setSelectedUnitId(e.target.value)}
              className="rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white"
            >
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.unitNumber} ({eq.type.toUpperCase()}) · {eq.operatingHours.toLocaleString()} hrs
                </option>
              ))}
            </select>

            <div className="inline-flex rounded border border-white/15 bg-bro-obsidian p-0.5">
              <button
                type="button"
                onClick={() => setTwinMode('LIVE_D1_TELEMETRY')}
                className={`px-3 py-1.5 rounded font-mono text-[11px] cursor-pointer ${
                  twinMode === 'LIVE_D1_TELEMETRY'
                    ? 'bg-bro-cyan text-bro-obsidian font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                [LIVE_D1_TELEMETRY]
              </button>
              <button
                type="button"
                onClick={() => setTwinMode('DIGITAL_TWIN_SANDBOX')}
                className={`px-3 py-1.5 rounded font-mono text-[11px] cursor-pointer ${
                  twinMode === 'DIGITAL_TWIN_SANDBOX'
                    ? 'bg-bro-gold text-bro-obsidian font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                [DIGITAL_TWIN_SANDBOX]
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left: Live Telemetry / Sandbox Fault Sliders */}
          <div className="xl:col-span-6 space-y-4">
            {twinMode === 'LIVE_D1_TELEMETRY' ? (
              <div className="p-4 rounded-lg bg-bro-obsidian/80 border border-white/10 space-y-4">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-bro-cyan font-bold uppercase">
                    Synced D1 Sensor Telemetry — {selectedUnit?.unitNumber || 'Fleet Unit'}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {latestUnitTel
                      ? `Recorded ${new Date(latestUnitTel.recordedAt).toISOString().slice(11, 19)}Z`
                      : 'Nominal Unit Baseline'}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono text-xs tabular-nums">
                  <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                    <div className="text-[10px] text-slate-400 uppercase flex items-center gap-1">
                      <Thermometer className="w-3 h-3 text-bro-cyan" /> Reefer Temp / Setpoint
                    </div>
                    <div className="text-sm font-bold text-white mt-1">
                      {effectiveCovariates.actualTempC.toFixed(1)}°C / {effectiveCovariates.setpointC.toFixed(1)}°C
                    </div>
                    <div className="text-[10px] text-slate-400">Δ {effectiveCovariates.tempDeviationC.toFixed(1)}°C</div>
                  </div>

                  <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                    <div className="text-[10px] text-slate-400 uppercase flex items-center gap-1">
                      <Gauge className="w-3 h-3 text-bro-gold" /> TPMS Pressure
                    </div>
                    <div className="text-sm font-bold text-white mt-1">{effectiveCovariates.tpmsPsi} PSI</div>
                    <div className="text-[10px] text-slate-400">Δ {effectiveCovariates.tpmsDeviationPsi} PSI vs 105</div>
                  </div>

                  <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                    <div className="text-[10px] text-slate-400 uppercase flex items-center gap-1">
                      <Activity className="w-3 h-3 text-bro-cyan" /> Chassis Vibration
                    </div>
                    <div className="text-sm font-bold text-white mt-1">
                      {effectiveCovariates.vibrationHz.toFixed(1)} Hz
                    </div>
                    <div className="text-[10px] text-slate-400">Nominal &lt;= 12.0 Hz</div>
                  </div>

                  <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                    <div className="text-[10px] text-slate-400 uppercase">Operating Hours</div>
                    <div className="text-sm font-bold text-white mt-1">
                      {effectiveCovariates.operatingHours.toLocaleString()} hrs
                    </div>
                  </div>

                  <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                    <div className="text-[10px] text-slate-400 uppercase">Rear Door Seal</div>
                    <div
                      className={`text-sm font-bold mt-1 ${
                        effectiveCovariates.doorClosed ? 'text-emerald-300' : 'text-bro-crimson'
                      }`}
                    >
                      {effectiveCovariates.doorClosed ? 'SEALED CLOSED' : 'DOOR AJAR ALERT'}
                    </div>
                  </div>

                  <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                    <div className="text-[10px] text-slate-400 uppercase">Axle Load</div>
                    <div className="text-sm font-bold text-white mt-1">
                      {effectiveCovariates.axleWeightKg ? `${effectiveCovariates.axleWeightKg.toLocaleString()} kg` : '—'}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setTwinMode('DIGITAL_TWIN_SANDBOX')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-gold/15 border border-bro-gold/40 font-mono text-[11px] font-bold text-bro-gold hover:bg-bro-gold/25 cursor-pointer"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    Inject Faults in Sandbox Mode
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-bro-obsidian/80 border border-bro-gold/35 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold uppercase text-bro-gold">
                    Interactive Fault Injection Sandbox
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={syncSandboxFromLive}
                      className="px-2 py-1 rounded bg-bro-steel border border-white/15 font-mono text-[10px] text-slate-200 hover:text-white cursor-pointer"
                    >
                      Reset to D1 Baseline
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSandboxTempDevC(5.8);
                        setSandboxTpmsDropPsi(8);
                        setSandboxVibHz(16.5);
                        setSandboxHours(4600);
                      }}
                      className="px-2 py-1 rounded bg-bro-gold/15 border border-bro-gold/40 font-mono text-[10px] text-bro-gold cursor-pointer"
                    >
                      Reefer Drift Fault
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSandboxTempDevC(7.5);
                        setSandboxTpmsDropPsi(24);
                        setSandboxVibHz(28.0);
                        setSandboxHours(6200);
                      }}
                      className="px-2 py-1 rounded bg-rose-950/70 border border-bro-crimson/50 font-mono text-[10px] text-rose-200 cursor-pointer"
                    >
                      Critical Bearing + TPMS
                    </button>
                  </div>
                </div>

                {/* 4 Interactive Fault Sliders */}
                <div className="space-y-3.5 font-mono text-xs">
                  <div>
                    <div className="flex justify-between mb-1">
                      <label htmlFor="slider-temp" className="text-slate-300">
                        Reefer Temp Deviation (Setpoint {sandboxSetpointC.toFixed(1)}°C -&gt;{' '}
                        {(sandboxSetpointC + sandboxTempDevC).toFixed(1)}°C)
                      </label>
                      <span className="text-bro-cyan font-bold tabular-nums">+{sandboxTempDevC.toFixed(1)} °C</span>
                    </div>
                    <input
                      id="slider-temp"
                      type="range"
                      min={0}
                      max={12}
                      step={0.1}
                      value={sandboxTempDevC}
                      onChange={(e) => setSandboxTempDevC(Number(e.target.value))}
                      className="w-full accent-cyan-400 cursor-pointer"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <label htmlFor="slider-tpms" className="text-slate-300">
                        TPMS Pressure Drop (Live: {Math.max(40, 105 - sandboxTpmsDropPsi)} PSI vs 105 PSI)
                      </label>
                      <span className="text-bro-gold font-bold tabular-nums">-{sandboxTpmsDropPsi} PSI</span>
                    </div>
                    <input
                      id="slider-tpms"
                      type="range"
                      min={0}
                      max={45}
                      step={1}
                      value={sandboxTpmsDropPsi}
                      onChange={(e) => setSandboxTpmsDropPsi(Number(e.target.value))}
                      className="w-full accent-amber-400 cursor-pointer"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <label htmlFor="slider-vib" className="text-slate-300">
                        Chassis Vibration Frequency (Nominal 12.0 Hz)
                      </label>
                      <span className="text-bro-crimson font-bold tabular-nums">{sandboxVibHz.toFixed(1)} Hz</span>
                    </div>
                    <input
                      id="slider-vib"
                      type="range"
                      min={10}
                      max={45}
                      step={0.5}
                      value={sandboxVibHz}
                      onChange={(e) => setSandboxVibHz(Number(e.target.value))}
                      className="w-full accent-rose-500 cursor-pointer"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <label htmlFor="slider-hrs" className="text-slate-300">
                        Cumulative Operating Hours (η = 8,500h, k = 2.1)
                      </label>
                      <span className="text-white font-bold tabular-nums">{sandboxHours.toLocaleString()} hrs</span>
                    </div>
                    <input
                      id="slider-hrs"
                      type="range"
                      min={100}
                      max={10000}
                      step={50}
                      value={sandboxHours}
                      onChange={(e) => setSandboxHours(Number(e.target.value))}
                      className="w-full accent-cyan-400 cursor-pointer"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right: Bounded Weibull-Cox Output Gauges + Survival Curve */}
          <div className="xl:col-span-6 p-4 rounded-lg bg-bro-obsidian/80 border border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-bold uppercase text-white">
                Proportional Hazards Output ({twinMode})
              </span>
              <span className={`px-2.5 py-0.5 rounded border font-mono text-[11px] font-bold uppercase ${riskBadgeClass}`}>
                {weibull.riskTier}
                {weibull.maintenanceUrgent ? ' · MAINTENANCE URGENT' : ''}
              </span>
            </div>

            {/* Strictly Bounded [0..100%] Failure Risk Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-mono text-xs">
                <span className="text-slate-400">Cumulative Failure Risk [0..100%]</span>
                <span className="text-lg font-bold text-white tabular-nums">
                  {Math.min(100, Math.max(0, weibull.failureRiskPct)).toFixed(1)}%
                </span>
              </div>
              <div className="h-3 rounded-full bg-slate-900 border border-white/10 overflow-hidden">
                <div
                  className={`h-full transition-all ${riskBarColor}`}
                  style={{ width: `${Math.min(100, Math.max(0, weibull.failureRiskPct))}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 font-mono tabular-nums">
              <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                <div className="text-[10px] text-slate-400 uppercase">Survival S(t)</div>
                <div className="text-lg font-bold text-bro-cyan mt-1">
                  {(weibull.survivalProbability * 100).toFixed(2)}%
                </div>
                <div className="text-[10px] text-slate-500">raw {weibull.survivalProbability.toFixed(4)}</div>
              </div>

              <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                <div className="text-[10px] text-slate-400 uppercase">Remaining Life (RUL)</div>
                <div className="text-lg font-bold text-white mt-1">
                  {weibull.remainingUsefulLifeHours.toLocaleString()} h
                </div>
                <div className="text-[10px] text-slate-500">
                  ~{Math.round(weibull.remainingUsefulLifeHours / 24)} op days
                </div>
              </div>

              <div className="p-3 rounded bg-bro-steel/70 border border-white/10">
                <div className="text-[10px] text-slate-400 uppercase">Hazard λ(t|z)</div>
                <div className="text-lg font-bold text-bro-gold mt-1">
                  {weibull.instantaneousHazard.toFixed(5)}
                </div>
                <div className="text-[10px] text-slate-500">events / hr</div>
              </div>
            </div>

            {/* Deterministic SVG Survival Curve S(t) */}
            <div className="p-3 rounded bg-black/50 border border-white/10">
              <div className="flex items-center justify-between font-mono text-[10px] text-slate-400 mb-1.5">
                <span>Survival Curve S(t | z) · 0h to 10,000h</span>
                <span className="tabular-nums">t = {effectiveCovariates.operatingHours.toLocaleString()}h</span>
              </div>
              <svg viewBox="0 0 320 100" className="w-full h-24 overflow-visible" role="img" aria-label="Weibull Survival Curve">
                <line x1="0" y1="50" x2="320" y2="50" stroke="rgba(255,255,255,0.1)" strokeDasharray="3 3" />
                <path d={survivalCurvePath} fill="none" stroke="#00f0ff" strokeWidth="2.2" />
                <circle
                  cx={currentMarkerX}
                  cy={currentMarkerY}
                  r="4.5"
                  fill={weibull.riskTier === 'CRITICAL' ? '#ff0055' : weibull.riskTier === 'ELEVATED' ? '#ffaa00' : '#00f0ff'}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* 30-Day Compliance Expiry Watchdog */}
      <section aria-label="30-Day Compliance Expiry Watchdog" className="glass-panel rounded-lg border border-bro-crimson/35 overflow-hidden">
        <div className="p-4 border-b border-white/10 bg-rose-950/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-bro-crimson" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              30-Day Compliance Expiry Watchdog (Medical Cards &amp; Annual DOT/NSC Inspections)
            </h2>
          </div>
          <span className="px-2 py-0.5 rounded bg-bro-crimson/20 border border-bro-crimson/40 font-mono text-[10px] font-bold text-rose-200 tabular-nums">
            {complianceAlerts.length} EXPIRING &lt;30D
          </span>
        </div>

        <div className="p-4">
          {complianceAlerts.length === 0 ? (
            <div className="flex items-center gap-2 font-mono text-xs text-emerald-300">
              <CheckCircle2 className="w-4 h-4" />
              All driver medical cards, commercial licenses, and equipment annual inspections are valid &gt;30 days.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {complianceAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border flex items-center justify-between gap-3 ${
                    alert.daysLeft <= 7
                      ? 'bg-rose-950/50 border-bro-crimson/50'
                      : 'bg-bro-gold/10 border-bro-gold/40'
                  }`}
                >
                  <div>
                    <div className="font-mono text-[10px] uppercase text-slate-300">{alert.entityType}</div>
                    <div className="font-mono text-xs font-bold text-white mt-0.5">{alert.entityLabel}</div>
                    <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                      Expires {formatDateIso(alert.expiryMs)}
                    </div>
                  </div>
                  <span
                    className={`px-2 py-1 rounded font-mono text-xs font-bold tabular-nums shrink-0 ${
                      alert.daysLeft <= 7
                        ? 'bg-bro-crimson text-white'
                        : 'bg-bro-gold text-bro-obsidian'
                    }`}
                  >
                    {alert.daysLeft <= 0 ? 'EXPIRED' : `${alert.daysLeft}d`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Equipment Registry Table */}
      <section aria-label="Commercial Fleet Equipment Registry" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-bro-cyan" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Commercial Equipment Registry ({equipment.length})
            </h2>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">Unit #</th>
                <th className="px-4 py-2.5">Division / Type</th>
                <th className="px-4 py-2.5">VIN / Plate</th>
                <th className="px-4 py-2.5 text-right">Operating Hrs</th>
                <th className="px-4 py-2.5">Annual DOT/NSC Expiry</th>
                <th className="px-4 py-2.5">Safety Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs font-mono">
              {equipment.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    {loading ? 'Loading fleet registry...' : 'No equipment registered.'}
                  </td>
                </tr>
              ) : (
                equipment.map((eq) => {
                  const daysToInsp = Math.ceil((eq.annualInspectionExpiry - Date.now()) / 86_400_000);
                  return (
                    <tr key={eq.id} className="hover:bg-white/5">
                      <td className="px-4 py-3 font-bold text-white whitespace-nowrap">{eq.unitNumber}</td>
                      <td className="px-4 py-3 uppercase text-bro-cyan whitespace-nowrap">
                        {eq.type.replace(/_/g, ' ')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-200">{eq.vin}</div>
                        <div className="text-[10px] text-slate-400">
                          {eq.plate} ({eq.jurisdiction}) · GVWR {eq.gvwrKg.toLocaleString()} kg
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-200 whitespace-nowrap">
                        {eq.operatingHours.toLocaleString()} hrs
                      </td>
                      <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                        <span className={daysToInsp <= 30 ? 'text-bro-gold font-bold' : 'text-slate-300'}>
                          {formatDateIso(eq.annualInspectionExpiry)} ({daysToInsp}d)
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded border text-[10px] uppercase font-bold ${
                            eq.status === 'active'
                              ? 'bg-emerald-950/70 border-emerald-500/45 text-emerald-300'
                              : eq.status === 'maintenance'
                                ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                                : 'bg-rose-950/80 border-bro-crimson/60 text-rose-200'
                          }`}
                        >
                          {eq.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Digital DVIR Inspections & Mechanic OOS Clearance */}
      <section aria-label="DVIR Inspections and Out-Of-Service Clearances" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-bro-gold" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Digital DVIR Inspections &amp; Mechanic Out-Of-Service Clearance ({dvirs.length})
            </h2>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">Type / Signed</th>
                <th className="px-4 py-2.5">Driver &amp; Assets</th>
                <th className="px-4 py-2.5 text-right">Odometer</th>
                <th className="px-4 py-2.5">Inspection Result</th>
                <th className="px-4 py-2.5 text-right">Mechanic Clearance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs font-mono">
              {dvirs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No driver DVIR checklists submitted yet. Pre-trip / Post-trip reports from the Driver PWA appear here.
                  </td>
                </tr>
              ) : (
                dvirs.map((dvir) => {
                  const drv = driverMap.get(dvir.driverId);
                  const trc = equipMap.get(dvir.tractorId);
                  const trl = dvir.trailerId ? equipMap.get(dvir.trailerId) : null;
                  const defects = parseDefectCount(dvir.checklistJson);
                  const unitLocked = trc?.status === 'out_of_service' || trl?.status === 'out_of_service';
                  const needsClearance = (!dvir.safeToOperate || dvir.defectsFound || unitLocked) && !dvir.mechanicClearedAt;
                  return (
                    <tr key={dvir.id} className="hover:bg-white/5">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="uppercase font-bold text-white">{dvir.inspectionType.replace(/_/g, ' ')}</div>
                        <div className="text-[10px] text-slate-400 tabular-nums">
                          {new Date(dvir.signedAt).toISOString().slice(0, 16).replace('T', ' ')}Z
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-100">{drv?.fullName || dvir.driverSignatureName}</div>
                        <div className="text-[10px] text-slate-400">
                          Tractor: {trc?.unitNumber || dvir.tractorId}
                          {trl ? ` · Trailer: ${trl.unitNumber}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-300 whitespace-nowrap">
                        {dvir.odometerKm.toLocaleString()} km
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {dvir.safeToOperate && !dvir.defectsFound ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold">
                            <ShieldCheck className="w-3 h-3" /> SAFE TO OPERATE
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-950/70 border border-bro-crimson/50 text-rose-200 text-[10px] font-bold">
                            <ShieldAlert className="w-3 h-3 text-bro-crimson" />
                            {defects} DEFECT(S) · {!dvir.safeToOperate ? 'OUT OF SERVICE' : 'REPAIR NEEDED'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {dvir.mechanicClearedAt ? (
                          <span className="text-emerald-300 text-[10px]">
                            Cleared {formatDateIso(dvir.mechanicClearedAt)}
                          </span>
                        ) : needsClearance ? (
                          <button
                            type="button"
                            disabled={busyDvirId === dvir.id}
                            onClick={() => void handleMechanicClear(dvir)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-gold text-bro-obsidian text-[10px] font-bold uppercase hover:bg-amber-400 cursor-pointer disabled:opacity-50"
                          >
                            <Wrench className="w-3 h-3" />
                            {busyDvirId === dvir.id ? 'Clearing...' : 'Mechanic Clear Out-Of-Service'}
                          </button>
                        ) : (
                          <span className="text-slate-500 text-[10px]">No action required</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
