import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Cpu,
  FileCode2,
  Leaf,
  MapPin,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Truck,
} from 'lucide-react';
import type { EquipmentType, RateCalculationResult } from '@bro/contracts';
import { renderCode128Svg } from '../../lib/barcode';

interface CorridorPreset {
  id: string;
  title: string;
  subtitle: string;
  equipmentType: EquipmentType;
  originCity: string;
  originProvinceState: string;
  originCountry: 'CA' | 'US';
  originLat: number;
  originLon: number;
  destCity: string;
  destProvinceState: string;
  destCountry: 'CA' | 'US';
  destLat: number;
  destLon: number;
  weightLbs: number;
  tempSetpointC?: number;
  isFoodFda: boolean;
  scnControl: string;
  portLabel: string;
  commodity: string;
  telemetrySeries: number[];
}

const CORRIDORS: CorridorPreset[] = [
  {
    id: 'pei-bos',
    title: 'Charlottetown, PE → Boston, MA',
    subtitle: 'Atlantic Cold-Chain Reefer · CBP ACE PAPS',
    equipmentType: 'reefer',
    originCity: 'Charlottetown',
    originProvinceState: 'PE',
    originCountry: 'CA',
    originLat: 46.2507,
    originLon: -63.1375,
    destCity: 'Boston',
    destProvinceState: 'MA',
    destCountry: 'US',
    destLat: 42.3601,
    destLon: -71.0589,
    weightLbs: 38400,
    tempSetpointC: 2.0,
    isFoodFda: true,
    scnControl: 'BROP8843921',
    portLabel: 'Houlton, ME / Woodstock, NB (#0106)',
    commodity: 'Fresh PEI Agricultural Produce (FSMA)',
    telemetrySeries: [2.1, 2.0, 2.0, 1.9, 2.0, 2.1, 2.0, 2.0, 1.9, 2.0, 2.0, 2.0],
  },
  {
    id: 'hfx-ewr',
    title: 'Halifax, NS → Newark, NJ',
    subtitle: 'Port-to-Port High-Cube Dry Van · Express Corridor',
    equipmentType: 'dry_van',
    originCity: 'Halifax',
    originProvinceState: 'NS',
    originCountry: 'CA',
    originLat: 44.6488,
    originLon: -63.5752,
    destCity: 'Newark',
    destProvinceState: 'NJ',
    destCountry: 'US',
    destLat: 40.7128,
    destLon: -74.006,
    weightLbs: 41000,
    isFoodFda: false,
    scnControl: 'BROP7721048',
    portLabel: 'Calais, ME / St. Stephen, NB (#0115)',
    commodity: 'Containerized Medical & Consumer Goods',
    telemetrySeries: [21.0, 21.1, 21.0, 20.9, 21.0, 21.1, 21.2, 21.0, 20.9, 21.0, 21.0, 21.0],
  },
  {
    id: 'mtl-chi',
    title: 'Montreal, QC → Chicago, IL',
    subtitle: 'Industrial Steel Flatbed · Great Lakes Heavy Corridor',
    equipmentType: 'flatbed',
    originCity: 'Montreal',
    originProvinceState: 'QC',
    originCountry: 'CA',
    originLat: 45.5017,
    originLon: -73.5673,
    destCity: 'Chicago',
    destProvinceState: 'IL',
    destCountry: 'US',
    destLat: 41.8781,
    destLon: -87.6298,
    weightLbs: 44200,
    isFoodFda: false,
    scnControl: 'BROP9948201',
    portLabel: 'Champlain, NY / Lacolle, QC (#0712)',
    commodity: 'Structural Aluminum & Coil Steel Bundles',
    telemetrySeries: [99.8, 99.9, 100, 99.9, 99.8, 99.9, 100, 100, 99.9, 99.8, 99.9, 100],
  },
  {
    id: 'tor-dtw',
    title: 'Toronto, ON → Detroit, MI',
    subtitle: 'JIT Automotive Shuttle · Ambassador / Blue Water',
    equipmentType: 'dry_van',
    originCity: 'Toronto',
    originProvinceState: 'ON',
    originCountry: 'CA',
    originLat: 43.6532,
    originLon: -79.3832,
    destCity: 'Detroit',
    destProvinceState: 'MI',
    destCountry: 'US',
    destLat: 42.3314,
    destLon: -83.0458,
    weightLbs: 34500,
    isFoodFda: false,
    scnControl: 'BROP6612095',
    portLabel: 'Detroit, MI / Windsor, ON (#3801)',
    commodity: 'Tier-1 Precision EV Powertrain Assemblies',
    telemetrySeries: [19.4, 19.5, 19.5, 19.4, 19.5, 19.5, 19.6, 19.5, 19.4, 19.5, 19.5, 19.5],
  },
];

const PIPELINE_STAGES = [
  {
    step: '1',
    title: 'EDI 204 Tender Ingest',
    tag: 'ANSI X12 · Auto-997',
    detail: 'Inbound shipper EDI 204 parsed deterministically on Cloudflare Workers, validating stop sequences and generating instant 997 functional acknowledgements.',
  },
  {
    step: '2',
    title: 'CARM R2 & ISO VIN Gate',
    tag: 'ACE PAPS · ACI PARS',
    detail: 'Before dispatch clears a tractor, our pre-flight engine validates ISO 3779 VIN check digits, FDA 2-hour Prior Notice, and CBSA CARM RPP bond compliance.',
  },
  {
    step: '3',
    title: 'Driver Offline PWA & 214 GPS',
    tag: 'IndexedDB · PoW',
    detail: 'Zero-signal border zones never stall operations: camera scans compress locally to WebP and queue cleanly behind SHA-256 Proof-of-Work until uplink returns.',
  },
  {
    step: '4',
    title: 'Workers AI Vision + HITL',
    tag: '92% Confidence Gate',
    detail: 'Workers AI extracts BOL, PAPS, fuel liters, and OS&D exceptions from R2 scans—pausing durable Workflows for human sign-off whenever confidence < 92%.',
  },
  {
    step: '5',
    title: 'ECDSA eBOL & Factoring PDF',
    tag: 'P-256 · Zero-Rated Tax',
    detail: 'Cryptographically chained pickup and POD blocks auto-generate audit-ready factoring packets, zero-rated cross-border invoices, and driver settlements.',
  },
];

export default function CorridorTwinShowcase() {
  const [selectedId, setSelectedId] = useState<string>(CORRIDORS[0].id);
  const [activeStageIdx, setActiveStageIdx] = useState<number>(1);
  const [estimate, setEstimate] = useState<RateCalculationResult | null>(null);
  const [routingSource, setRoutingSource] = useState<string>('OSRM / GEO');
  const [portWaitMins, setPortWaitMins] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const corridor = useMemo(
    () => CORRIDORS.find((c) => c.id === selectedId) ?? CORRIDORS[0],
    [selectedId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    fetch('/api/quotes/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        equipmentType: corridor.equipmentType,
        originCity: corridor.originCity,
        originProvinceState: corridor.originProvinceState,
        originCountry: corridor.originCountry,
        originLat: corridor.originLat,
        originLon: corridor.originLon,
        destCity: corridor.destCity,
        destProvinceState: corridor.destProvinceState,
        destCountry: corridor.destCountry,
        destLat: corridor.destLat,
        destLon: corridor.destLon,
        weightLbs: corridor.weightLbs,
        tempSetpointC: corridor.tempSetpointC,
        requiresTarp: corridor.equipmentType === 'flatbed',
        requiresStrapping: corridor.equipmentType === 'flatbed',
        requiresTeamDriver: false,
        isHazmat: false,
        isFoodFda: corridor.isFoodFda,
        currency: 'CAD',
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((raw: unknown) => {
        const data = raw as {
          estimate?: RateCalculationResult;
          routingSource?: string;
          recommendedPort?: { waitMinutes: number | null } | null;
        } | null;
        if (data?.estimate) {
          setEstimate(data.estimate);
          setRoutingSource(data.routingSource || 'OSRM');
          setPortWaitMins(data.recommendedPort?.waitMinutes ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [corridor]);

  const barcodeSvg = useMemo(
    () => renderCode128Svg(corridor.scnControl, { height: 40, moduleWidth: 1.8, includeText: true }),
    [corridor.scnControl],
  );

  const telemetryPolyline = useMemo(() => {
    const pts = corridor.telemetrySeries;
    const min = Math.min(...pts) - 0.5;
    const max = Math.max(...pts) + 0.5;
    const span = Math.max(0.5, max - min);
    return pts
      .map((val, i) => {
        const x = (i / (pts.length - 1)) * 220;
        const y = 42 - ((val - min) / span) * 32;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [corridor.telemetrySeries]);

  const fmtCad = (cents: number) =>
    (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

  const quoteHref = `/quote?equipment=${corridor.equipmentType}&origin=${encodeURIComponent(corridor.originCity)}&dest=${encodeURIComponent(corridor.destCity)}&weight=${corridor.weightLbs}`;

  return (
    <section className="rounded-3xl surface-ceramic overflow-hidden">
      {/* Top Visual Banner With Photorealistic International Bridge Hero */}
      <div className="relative min-h-[15rem] sm:min-h-[16rem] h-auto flex flex-col justify-end overflow-hidden border-b border-white/[0.08]">
        <img
          src="/images/fleet/corridor-bridge.webp"
          alt="International cross-border bridge customs plaza illuminated at dusk"
          width={1280}
          height={714}
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover object-center opacity-75"
          loading="lazy"
        />
        <div
          className="absolute inset-0 bg-gradient-to-t from-[#090d18] via-[#090d18]/70 to-transparent"
          aria-hidden="true"
        />
        <div className="relative z-10 p-5 sm:p-8 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-bro-cyan">
              <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Interactive Corridor Mission Twin</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
              Watch Freight Clear Borders in Real Time
            </h2>
          </div>

          {/* Interactive Corridor Pill Selector */}
          <div
            role="group"
            aria-label="Select cross-border freight corridor"
            className="flex flex-wrap gap-1.5 p-1.5 rounded-2xl liquid-glass"
          >
            {CORRIDORS.map((c) => {
              const active = c.id === corridor.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  aria-pressed={active}
                  className={`min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    active ? 'bg-white text-black font-semibold shadow-sm' : 'text-slate-200 hover:bg-white/10'
                  }`}
                >
                  {c.originProvinceState} → {c.destProvinceState}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Digital Twin Workspace */}
      <div className="p-5 sm:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left 7 cols: Corridor Telemetry + Customs Barcode + Thermal/Securement Curve */}
        <div className="lg:col-span-7 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xl font-display font-bold text-white tracking-tight">{corridor.title}</h3>
              <p className="text-xs text-slate-300 mt-0.5">{corridor.subtitle}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-emerald-400/35 bg-emerald-500/10 text-xs font-medium text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> CARM R2 Pre-Cleared
            </span>
          </div>

          {/* 3 Live Telemetry Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-4 rounded-2xl bg-[#060913] border border-white/[0.08]">
              <div className="text-xs text-slate-300">Live Lane Estimate</div>
              <div
                className={`mt-1 font-display text-2xl font-bold text-white tabular-nums transition-opacity duration-200 ${
                  loading && estimate ? 'opacity-60' : 'opacity-100'
                }`}
              >
                {estimate ? `${fmtCad(estimate.totalCents)} CAD` : 'Computing…'}
              </div>
              <div
                className={`mt-1 font-mono text-[11px] text-bro-cyan tabular-nums transition-opacity duration-200 ${
                  loading && estimate ? 'opacity-60' : 'opacity-100'
                }`}
              >
                {estimate ? `${estimate.distanceKm.toLocaleString()} km · ${estimate.estimatedTransitHours}h` : routingSource}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-[#060913] border border-white/[0.08]">
              <div className="text-xs text-slate-300 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-bro-gold shrink-0" aria-hidden="true" /> Primary Port
              </div>
              <div className="mt-1 text-xs font-semibold text-white leading-snug">{corridor.portLabel}</div>
              <div className="mt-1 font-mono text-[11px] text-bro-gold tabular-nums">
                {portWaitMins !== null ? `Live CBP Wait: ${portWaitMins} min` : 'PAPS / PARS Electronic Queue'}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-[#060913] border border-white/[0.08]">
              <div className="text-xs text-slate-300 flex items-center gap-1.5">
                <Leaf className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" /> SmartWay Footprint
              </div>
              <div
                className={`mt-1 font-display text-2xl font-bold text-emerald-300 tabular-nums transition-opacity duration-200 ${
                  loading && estimate ? 'opacity-60' : 'opacity-100'
                }`}
              >
                {estimate ? `${estimate.co2Kg} kg` : '—'}
              </div>
              <div className="mt-1 font-mono text-[11px] text-slate-300">
                0% Zero-Rated Cross-Border Tax
              </div>
            </div>
          </div>

          {/* Dual Interactive Proof Panels: Code-128B Barcode + Chamber Telemetry */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl bg-[#060913] border border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-slate-200 flex items-center gap-1.5">
                  <FileCode2 className="w-3.5 h-3.5 text-bro-cyan shrink-0" aria-hidden="true" /> Scannable ACE PAPS
                </span>
                <span className="font-mono text-[11px] text-bro-cyan">{corridor.scnControl}</span>
              </div>
              <div className="p-3 rounded-xl bg-white flex justify-center overflow-hidden">
                <div className="w-full max-w-full flex justify-center" dangerouslySetInnerHTML={{ __html: barcodeSvg }} />
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-[#060913] border border-white/[0.08] space-y-3 flex flex-col justify-between">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-slate-200 flex items-center gap-1.5">
                  {corridor.equipmentType === 'reefer' ? (
                    <Snowflake className="w-3.5 h-3.5 text-bro-cyan shrink-0" aria-hidden="true" />
                  ) : (
                    <Truck className="w-3.5 h-3.5 text-bro-gold shrink-0" aria-hidden="true" />
                  )}
                  <span>
                    {corridor.equipmentType === 'reefer' ? 'FSMA Thermal Stability' : 'Load Integrity Index'}
                  </span>
                </span>
                <span className="font-mono text-[11px] text-emerald-300 tabular-nums">
                  {corridor.equipmentType === 'reefer' ? `${corridor.tempSetpointC?.toFixed(1)}°C LOCKED` : '100% INTACT'}
                </span>
              </div>
              <svg viewBox="0 0 220 48" className="w-full h-14 overflow-visible" aria-hidden="true">
                <polyline
                  fill="none"
                  stroke={corridor.equipmentType === 'flatbed' ? '#FFAA00' : '#00F0FF'}
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={telemetryPolyline}
                />
              </svg>
              <div className="text-xs text-slate-300 truncate">{corridor.commodity}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>Deterministic contract rate + OSRM routing engine</span>
            </div>
            <a
              href={quoteHref}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-black hover:bg-bro-cyan text-xs font-semibold tracking-tight transition-colors"
            >
              <span>Lock &amp; Book This Exact Lane</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>

        {/* Right 5 cols: Interactive 5-Stage Autonomous Dispatch Pipeline */}
        <div className="lg:col-span-5 space-y-3 bg-[#060913] border border-white/[0.08] rounded-2xl p-5">
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
            <span className="text-xs font-semibold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
              <span>Autonomous Border-to-Cash Flow</span>
            </span>
            <span className="font-mono text-[11px] text-slate-300">5 Stages</span>
          </div>

          <div className="space-y-2">
            {PIPELINE_STAGES.map((st, idx) => {
              const active = idx === activeStageIdx;
              return (
                <button
                  key={st.step}
                  type="button"
                  onClick={() => setActiveStageIdx(idx)}
                  aria-expanded={active}
                  className={`w-full min-h-[44px] text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                    active
                      ? 'border-bro-cyan/50 bg-bro-cyan/[0.08]'
                      : 'border-white/[0.06] bg-white/[0.02] hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-6 h-6 rounded-full font-mono text-[11px] font-bold flex items-center justify-center shrink-0 ${
                          active ? 'bg-bro-cyan text-black' : 'bg-white/10 text-slate-200'
                        }`}
                      >
                        {st.step}
                      </span>
                      <span className="text-xs font-semibold text-white">{st.title}</span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-300 shrink-0">{st.tag}</span>
                  </div>
                  <div
                    className="bro-accordion-content"
                    aria-expanded={active}
                    aria-hidden={!active}
                  >
                    <div>
                      <p className="pt-2.5 pl-8 text-xs text-slate-300 leading-relaxed">{st.detail}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
