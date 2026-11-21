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
      ? 'bg-rose-950/70 text-rose-200 border-rose-400/50'
      : weibull.riskTier === 'ELEVATED'
        ? 'bg-bro-gold/15 text-bro-gold border-bro-gold/45'
        : 'bg-emerald-950/70 text-emerald-200 border-emerald-400/45';

  const riskBarColor =
    weibull.riskTier === 'CRITICAL'
      ? 'bg-rose-500'
      : weibull.riskTier === 'ELEVATED'
        ? 'bg-bro-gold'
        : 'bg-bro-cyan';

  const modeLabel = twinMode === 'LIVE_D1_TELEMETRY' ? 'Live D1 Telemetry' : 'Digital Twin Sandbox';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-cyan">
            Weibull-Cox Digital Twin · DVIR Safety Lock · NSC/DOT Watchdog
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Fleet Safety &amp; Predictive Maintenance Desk
          </h1>
        </div>
        <button
          type="button"
          onClick={() => void fetchFleet()}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-xs font-semibold text-white cursor-pointer transition-colors"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          <span>Refresh Fleet Telemetry</span>
        </button>
      </div>

      {/* Inline Feedback Banner */}
      {banner && (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border text-xs font-medium ${
            banner.kind === 'error'
              ? 'bg-rose-950/60 border-rose-400/50 text-rose-200'
              : 'bg-emerald-950/60 border-emerald-400/40 text-emerald-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Dismiss message"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer shrink-0 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Interactive Weibull-Cox Predictive Maintenance Digital Twin */}
      <section
        aria-label="Weibull-Cox Predictive Maintenance Digital Twin"
        className="surface-ceramic rounded-2xl border border-bro-cyan/30 p-5 sm:p-6 space-y-5"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div className="flex items-start sm:items-center gap-3">
            <Cpu className="w-5 h-5 text-bro-cyan shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-bold text-white">
                Weibull-Cox Proportional Hazards Digital Twin
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                S(t|z) = exp(-(t/η)^k · exp(βᵀz)) · Deterministic reliability engine from @bro/contracts
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            <select
              aria-label="Select fleet unit for Weibull-Cox analysis"
              value={selectedUnit?.id || ''}
              onChange={(e) => setSelectedUnitId(e.target.value)}
              className="w-full sm:w-auto max-w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3.5 py-2.5 min-h-[44px] font-mono text-xs text-white outline-none"
            >
              {equipment.length === 0 ? (
                <option value="">No fleet equipment registered</option>
              ) : (
                equipment.map((eq) => (
                  <option key={eq.id} value={eq.id}>
                    {eq.unitNumber} ({eq.type.toUpperCase()}) · {eq.operatingHours.toLocaleString()} hrs
                  </option>
                ))
              )}
            </select>

            <div
              role="group"
              aria-label="Weibull telemetry source mode"
              className="flex flex-wrap items-center gap-1 rounded-2xl sm:rounded-full border border-white/10 bg-[#060912] p-1 w-full sm:w-auto"
            >
              <button
                type="button"
                aria-pressed={twinMode === 'LIVE_D1_TELEMETRY'}
                onClick={() => setTwinMode('LIVE_D1_TELEMETRY')}
                className={`flex-1 sm:flex-initial px-4 py-2 min-h-[44px] rounded-xl sm:rounded-full text-xs font-semibold cursor-pointer transition-colors ${
                  twinMode === 'LIVE_D1_TELEMETRY'
                    ? 'bg-bro-cyan text-bro-obsidian font-bold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Live D1 Telemetry
              </button>
              <button
                type="button"
                aria-pressed={twinMode === 'DIGITAL_TWIN_SANDBOX'}
                onClick={() => setTwinMode('DIGITAL_TWIN_SANDBOX')}
                className={`flex-1 sm:flex-initial px-4 py-2 min-h-[44px] rounded-xl sm:rounded-full text-xs font-semibold cursor-pointer transition-colors ${
                  twinMode === 'DIGITAL_TWIN_SANDBOX'
                    ? 'bg-bro-gold text-bro-obsidian font-bold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Digital Twin Sandbox
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left: Live Telemetry / Sandbox Fault Sliders */}
          <div className="xl:col-span-6 space-y-4">
            {twinMode === 'LIVE_D1_TELEMETRY' ? (
              <div className="p-4 sm:p-5 rounded-2xl bg-[#0b1120] border border-white/10 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-bro-cyan font-semibold">
                    Synced D1 Sensor Telemetry — {selectedUnit?.unitNumber || 'Fleet Unit'}
                  </span>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {latestUnitTel
                      ? `Recorded ${new Date(latestUnitTel.recordedAt).toISOString().slice(11, 19)}Z`
                      : 'Nominal Unit Baseline'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs tabular-nums">
                  <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                    <div className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Thermometer className="w-3.5 h-3.5 text-bro-cyan" aria-hidden="true" />
                      <span>Reefer / Setpoint</span>
                    </div>
                    <div className="text-sm font-mono font-bold text-white mt-1.5">
                      {effectiveCovariates.actualTempC.toFixed(1)}°C / {effectiveCovariates.setpointC.toFixed(1)}°C
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Δ {effectiveCovariates.tempDeviationC.toFixed(1)}°C
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                    <div className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Gauge className="w-3.5 h-3.5 text-bro-gold" aria-hidden="true" />
                      <span>TPMS Pressure</span>
                    </div>
                    <div className="text-sm font-mono font-bold text-white mt-1.5">
                      {effectiveCovariates.tpmsPsi} PSI
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Δ {effectiveCovariates.tpmsDeviationPsi} PSI vs 105
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                    <div className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-bro-cyan" aria-hidden="true" />
                      <span>Chassis Vibration</span>
                    </div>
                    <div className="text-sm font-mono font-bold text-white mt-1.5">
                      {effectiveCovariates.vibrationHz.toFixed(1)} Hz
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">Nominal &lt;= 12.0 Hz</div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                    <div className="text-xs text-slate-400">Operating Hours</div>
                    <div className="text-sm font-mono font-bold text-white mt-1.5">
                      {effectiveCovariates.operatingHours.toLocaleString()} hrs
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                    <div className="text-xs text-slate-400">Rear Door Seal</div>
                    <div
                      className={`text-sm font-bold mt-1.5 ${
                        effectiveCovariates.doorClosed ? 'text-emerald-300' : 'text-rose-200'
                      }`}
                    >
                      {effectiveCovariates.doorClosed ? 'Sealed Closed' : 'Door Ajar Alert'}
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                    <div className="text-xs text-slate-400">Axle Load</div>
                    <div className="text-sm font-mono font-bold text-white mt-1.5">
                      {effectiveCovariates.axleWeightKg ? `${effectiveCovariates.axleWeightKg.toLocaleString()} kg` : '—'}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setTwinMode('DIGITAL_TWIN_SANDBOX')}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-gold/15 border border-bro-gold/40 text-xs font-semibold text-bro-gold hover:bg-bro-gold/25 cursor-pointer transition-colors"
                  >
                    <Sliders className="w-4 h-4" aria-hidden="true" />
                    <span>Inject Faults in Sandbox Mode</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-4 sm:p-5 rounded-2xl bg-[#0b1120] border border-bro-gold/35 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <span className="text-xs font-bold uppercase tracking-wide text-bro-gold">
                    Interactive Fault Injection Sandbox
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={syncSandboxFromLive}
                      className="px-3 py-1.5 min-h-[40px] rounded-xl bg-[#070b16] border border-white/15 text-xs text-slate-200 hover:text-white hover:border-white/30 cursor-pointer transition-colors"
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
                      className="px-3 py-1.5 min-h-[40px] rounded-xl bg-bro-gold/15 border border-bro-gold/40 text-xs font-medium text-bro-gold hover:bg-bro-gold/25 cursor-pointer transition-colors"
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
                      className="px-3 py-1.5 min-h-[40px] rounded-xl bg-rose-950/70 border border-rose-400/50 text-xs font-medium text-rose-200 hover:bg-rose-900/70 cursor-pointer transition-colors"
                    >
                      Critical Bearing + TPMS
                    </button>
                  </div>
                </div>

                {/* 4 Interactive Fault Sliders */}
                <div className="space-y-4 text-xs">
                  <div>
                    <div className="flex justify-between gap-2 mb-1.5">
                      <label htmlFor="slider-temp" className="text-slate-300">
                        Reefer Temp Deviation (Setpoint {sandboxSetpointC.toFixed(1)}°C →{' '}
                        {(sandboxSetpointC + sandboxTempDevC).toFixed(1)}°C)
                      </label>
                      <span className="font-mono text-bro-cyan font-bold tabular-nums shrink-0">
                        +{sandboxTempDevC.toFixed(1)} °C
                      </span>
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
                    <div className="flex justify-between gap-2 mb-1.5">
                      <label htmlFor="slider-tpms" className="text-slate-300">
                        TPMS Pressure Drop (Live: {Math.max(40, 105 - sandboxTpmsDropPsi)} PSI vs 105 PSI)
                      </label>
                      <span className="font-mono text-bro-gold font-bold tabular-nums shrink-0">
                        -{sandboxTpmsDropPsi} PSI
                      </span>
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
                    <div className="flex justify-between gap-2 mb-1.5">
                      <label htmlFor="slider-vib" className="text-slate-300">
                        Chassis Vibration Frequency (Nominal 12.0 Hz)
                      </label>
                      <span className="font-mono text-rose-300 font-bold tabular-nums shrink-0">
                        {sandboxVibHz.toFixed(1)} Hz
                      </span>
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
                    <div className="flex justify-between gap-2 mb-1.5">
                      <label htmlFor="slider-hrs" className="text-slate-300">
                        Cumulative Operating Hours (η = 8,500h, k = 2.1)
                      </label>
                      <span className="font-mono text-white font-bold tabular-nums shrink-0">
                        {sandboxHours.toLocaleString()} hrs
                      </span>
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
          <div className="xl:col-span-6 p-4 sm:p-5 rounded-2xl bg-[#0b1120] border border-white/10 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-white">
                Proportional Hazards Output · {modeLabel}
              </span>
              <span className={`px-3 py-1 rounded-full border text-xs font-bold uppercase ${riskBadgeClass}`}>
                {weibull.riskTier}
                {weibull.maintenanceUrgent ? ' · Maintenance Urgent' : ''}
              </span>
            </div>

            {/* Strictly Bounded [0..100%] Failure Risk Bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300">Cumulative Failure Risk (0–100%)</span>
                <span className="text-xl font-display font-bold text-white tabular-nums">
                  {Math.min(100, Math.max(0, weibull.failureRiskPct)).toFixed(1)}%
                </span>
              </div>
              <div className="h-3 rounded-full bg-[#060912] border border-white/10 overflow-hidden">
                <div
                  className={`h-full transition-[width,background-color] duration-300 ${riskBarColor}`}
                  style={{ width: `${Math.min(100, Math.max(0, weibull.failureRiskPct))}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 tabular-nums">
              <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                <div className="text-xs text-slate-400">Survival S(t)</div>
                <div className="text-lg font-mono font-bold text-bro-cyan mt-1">
                  {(weibull.survivalProbability * 100).toFixed(2)}%
                </div>
                <div className="text-xs text-slate-400 mt-0.5">raw {weibull.survivalProbability.toFixed(4)}</div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                <div className="text-xs text-slate-400">Remaining Life (RUL)</div>
                <div className="text-lg font-mono font-bold text-white mt-1">
                  {weibull.remainingUsefulLifeHours.toLocaleString()} h
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  ~{Math.round(weibull.remainingUsefulLifeHours / 24)} op days
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#070b16] border border-white/10">
                <div className="text-xs text-slate-400">Hazard λ(t|z)</div>
                <div className="text-lg font-mono font-bold text-bro-gold mt-1">
                  {weibull.instantaneousHazard.toFixed(5)}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">events / hr</div>
              </div>
            </div>

            {/* Deterministic SVG Survival Curve S(t) */}
            <div className="p-3.5 rounded-xl bg-[#050811] border border-white/10">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300 mb-2">
                <span>Survival Curve S(t | z) · 0h to 10,000h</span>
                <span className="font-mono tabular-nums">
                  t = {effectiveCovariates.operatingHours.toLocaleString()}h
                </span>
              </div>
              <svg viewBox="0 0 320 100" className="w-full h-24 overflow-visible" role="img" aria-label="Weibull Survival Curve">
                <line x1="0" y1="50" x2="320" y2="50" stroke="rgba(255,255,255,0.1)" strokeDasharray="3 3" />
                <path d={survivalCurvePath} fill="none" stroke="#00f0ff" strokeWidth="2.2" />
                <circle
                  cx={currentMarkerX}
                  cy={currentMarkerY}
                  r="4.5"
                  fill={weibull.riskTier === 'CRITICAL' ? '#fb7185' : weibull.riskTier === 'ELEVATED' ? '#ffaa00' : '#00f0ff'}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* 30-Day Compliance Expiry Watchdog */}
      <section aria-label="30-Day Compliance Expiry Watchdog" className="surface-ceramic rounded-2xl border border-rose-400/35 overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 bg-rose-950/25 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-rose-300 shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              30-Day Compliance Expiry Watchdog (Medical Cards &amp; Annual DOT/NSC Inspections)
            </h2>
          </div>
          <span className="px-3 py-1 rounded-full bg-rose-950/80 border border-rose-400/50 text-xs font-bold text-rose-200 tabular-nums">
            {complianceAlerts.length} Expiring &lt;30d
          </span>
        </div>

        <div className="p-4 sm:p-5">
          {complianceAlerts.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" aria-hidden="true" />
              <span>
                All driver medical cards, commercial licenses, and equipment annual inspections are valid &gt;30 days.
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {complianceAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${
                    alert.daysLeft <= 7
                      ? 'bg-rose-950/55 border-rose-400/50'
                      : 'bg-bro-gold/10 border-bro-gold/40'
                  }`}
                >
                  <div>
                    <div className="text-xs font-medium text-slate-300">{alert.entityType}</div>
                    <div className="text-sm font-bold text-white mt-0.5">{alert.entityLabel}</div>
                    <div className="text-xs text-slate-400 tabular-nums mt-0.5">
                      Expires {formatDateIso(alert.expiryMs)}
                    </div>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold tabular-nums shrink-0 ${
                      alert.daysLeft <= 7
                        ? 'bg-rose-700 text-white'
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
      <section aria-label="Commercial Fleet Equipment Registry" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Commercial Equipment Registry ({equipment.length})
            </h2>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Unit #</th>
                <th className="px-4 py-3">Division / Type</th>
                <th className="px-4 py-3">VIN / Plate</th>
                <th className="px-4 py-3 text-right">Operating Hrs</th>
                <th className="px-4 py-3">Annual DOT/NSC Expiry</th>
                <th className="px-4 py-3">Safety Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs font-mono">
              {equipment.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center font-sans text-slate-300">
                    {loading ? 'Loading fleet registry...' : 'No equipment registered.'}
                  </td>
                </tr>
              ) : (
                equipment.map((eq) => {
                  const daysToInsp = Math.ceil((eq.annualInspectionExpiry - Date.now()) / 86_400_000);
                  return (
                    <tr key={eq.id} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3.5 font-bold text-white whitespace-nowrap">{eq.unitNumber}</td>
                      <td className="px-4 py-3.5 uppercase text-bro-cyan whitespace-nowrap">
                        {eq.type.replace(/_/g, ' ')}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="text-slate-200">{eq.vin}</div>
                        <div className="text-xs text-slate-400">
                          {eq.plate} ({eq.jurisdiction}) · GVWR {eq.gvwrKg.toLocaleString()} kg
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums text-slate-200 whitespace-nowrap">
                        {eq.operatingHours.toLocaleString()} hrs
                      </td>
                      <td className="px-4 py-3.5 tabular-nums whitespace-nowrap">
                        <span className={daysToInsp <= 30 ? 'text-bro-gold font-bold' : 'text-slate-300'}>
                          {formatDateIso(eq.annualInspectionExpiry)} ({daysToInsp}d)
                        </span>
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-1 rounded-full border text-xs uppercase font-semibold ${
                            eq.status === 'active'
                              ? 'bg-emerald-950/70 border-emerald-400/45 text-emerald-200'
                              : eq.status === 'maintenance'
                                ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                                : 'bg-rose-950/80 border-rose-400/60 text-rose-200'
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
      <section aria-label="DVIR Inspections and Out-Of-Service Clearances" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Digital DVIR Inspections &amp; Mechanic Out-Of-Service Clearance ({dvirs.length})
            </h2>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Type / Signed</th>
                <th className="px-4 py-3">Driver &amp; Assets</th>
                <th className="px-4 py-3 text-right">Odometer</th>
                <th className="px-4 py-3">Inspection Result</th>
                <th className="px-4 py-3 text-right">Mechanic Clearance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs font-mono">
              {dvirs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center font-sans text-slate-300">
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
                    <tr key={dvir.id} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <div className="uppercase font-bold text-white">{dvir.inspectionType.replace(/_/g, ' ')}</div>
                        <div className="text-xs text-slate-400 tabular-nums mt-0.5">
                          {new Date(dvir.signedAt).toISOString().slice(0, 16).replace('T', ' ')}Z
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="font-sans text-sm text-slate-100">{drv?.fullName || dvir.driverSignatureName}</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Tractor: {trc?.unitNumber || dvir.tractorId}
                          {trl ? ` · Trailer: ${trl.unitNumber}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums text-slate-300 whitespace-nowrap">
                        {dvir.odometerKm.toLocaleString()} km
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        {dvir.safeToOperate && !dvir.defectsFound ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/70 border border-emerald-400/40 text-emerald-200 text-xs font-semibold">
                            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" /> Safe to Operate
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-950/70 border border-rose-400/50 text-rose-200 text-xs font-semibold">
                            <ShieldAlert className="w-3.5 h-3.5 text-rose-300" aria-hidden="true" />
                            {defects} Defect(s) · {!dvir.safeToOperate ? 'Out of Service' : 'Repair Needed'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {dvir.mechanicClearedAt ? (
                          <span className="text-emerald-200 text-xs">
                            Cleared {formatDateIso(dvir.mechanicClearedAt)}
                          </span>
                        ) : needsClearance ? (
                          <button
                            type="button"
                            disabled={busyDvirId === dvir.id}
                            onClick={() => void handleMechanicClear(dvir)}
                            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-bro-gold text-bro-obsidian text-xs font-bold uppercase hover:bg-amber-400 cursor-pointer disabled:opacity-50 transition-colors"
                          >
                            <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{busyDvirId === dvir.id ? 'Clearing...' : 'Mechanic Clear Out-Of-Service'}</span>
                          </button>
                        ) : (
                          <span className="text-slate-400 text-xs">No action required</span>
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
