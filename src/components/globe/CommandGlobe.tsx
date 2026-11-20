import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Clock,
  Compass,
  MapPin,
  Navigation,
  Radio,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { EquipmentType } from '@bro/contracts';
import {
  BORDER_PORTS,
  CAMERA_PRESETS,
  CORRIDOR_ROUTES,
  HUB_LOCATIONS,
  buildQuoteUrlForNode,
  countRoutesForHub,
  type BorderWaitTimeDatum,
  type CameraPreset,
  type GlobeNode,
  type WaitSeverityStatus,
} from './globeData';
import { GlobeEngine } from './GlobeEngine';

export interface CommandGlobeProps {
  className?: string;
}

type FeedStatus = 'loading' | 'live' | 'standby';

const DIVISION_LABELS: Record<EquipmentType, string> = {
  dry_van: '53ft Dry Van',
  reefer: 'Climate Reefer',
  flatbed: 'Open Flatbed',
};

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function extractWaitTimeArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.ports)) return obj.ports;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.waitTimes)) return obj.waitTimes;
  }
  return [];
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeWaitTimePayload(payload: unknown): BorderWaitTimeDatum[] {
  const rows = extractWaitTimeArray(payload);
  const results: BorderWaitTimeDatum[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const rawCode = rec.cbpCode ?? rec.portCode ?? rec.port_code ?? rec.code;
    if (typeof rawCode !== 'string' && typeof rawCode !== 'number') continue;

    const cbpCode = String(rawCode).trim().padStart(4, '0');
    const commercialWaitMinutes = toFiniteNumber(
      rec.commercialWaitMinutes ??
        rec.commercialDelayMinutes ??
        rec.commercial_wait_minutes ??
        rec.commercial_delay_minutes ??
        rec.waitMinutes ??
        rec.delayMinutes,
    );
    const fastLaneWaitMinutes = toFiniteNumber(
      rec.fastLaneWaitMinutes ??
        rec.commercialFastMinutes ??
        rec.fast_lane_wait_minutes ??
        rec.fastWaitMinutes,
    );
    const rawUpdated = rec.updatedAt ?? rec.updated_at ?? rec.fetchedAt ?? rec.timestamp;
    const updatedAt = typeof rawUpdated === 'string' ? rawUpdated : null;

    results.push({
      cbpCode,
      commercialWaitMinutes,
      fastLaneWaitMinutes,
      updatedAt,
    });
  }

  return results;
}

function getWaitStatusStyles(status: WaitSeverityStatus): {
  badgeClass: string;
  valueClass: string;
  label: string;
} {
  switch (status) {
    case 'clear':
      return {
        badgeClass: 'border-bro-cyan/40 bg-bro-cyan/10 text-bro-cyan',
        valueClass: 'text-bro-cyan',
        label: 'CLEAR FLOW',
      };
    case 'moderate':
      return {
        badgeClass: 'border-bro-gold/40 bg-bro-gold/10 text-bro-gold',
        valueClass: 'text-bro-gold',
        label: 'MODERATE QUEUE',
      };
    case 'congested':
      return {
        badgeClass: 'border-bro-crimson/40 bg-bro-crimson/10 text-bro-crimson',
        valueClass: 'text-bro-crimson',
        label: 'HEAVY DELAY',
      };
    default:
      return {
        badgeClass: 'border-slate-700 bg-slate-900/70 text-slate-300',
        valueClass: 'text-slate-200',
        label: 'STANDBY',
      };
  }
}

function formatCoords(lat: number, lon: number): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

export default function CommandGlobe({ className = '' }: CommandGlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const [selectedNode, setSelectedNode] = useState<GlobeNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GlobeNode | null>(null);
  const [activePreset, setActivePreset] = useState<CameraPreset['id']>('north_america');
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('loading');
  const [webglFallback, setWebglFallback] = useState(false);

  // Mount & cleanly dispose GlobeEngine
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let engine: GlobeEngine | null = null;
    try {
      engine = new GlobeEngine({
        container,
        onSelectNode: (node) => setSelectedNode(node),
        onHoverNode: (node) => setHoveredNode(node),
        onContextLost: (lost) => setWebglFallback(lost),
      });
      engineRef.current = engine;
    } catch {
      setWebglFallback(true);
    }

    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Fetch live CBSA/CBP commercial border wait times & hydrate WebGL beacons
  useEffect(() => {
    let active = true;
    let controller = new AbortController();

    const loadBorderWaitTimes = async () => {
      controller.abort();
      controller = new AbortController();
      try {
        const res = await fetch('/api/borders/wait-times', {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (active) setFeedStatus('standby');
          return;
        }
        const json: unknown = await res.json();
        const normalized = normalizeWaitTimePayload(json);
        if (!active) return;

        if (normalized.length > 0) {
          engineRef.current?.updateBorderWaitTimes(normalized);
          setFeedStatus('live');
        } else {
          setFeedStatus('standby');
        }
      } catch (err) {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFeedStatus('standby');
      }
    };

    void loadBorderWaitTimes();
    const timer = setInterval(() => {
      void loadBorderWaitTimes();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  // Escape key closes the telemetry card cleanly
  const handleDismissCard = useCallback(() => {
    setSelectedNode(null);
    engineRef.current?.clearSelection();
  }, []);

  useEffect(() => {
    if (!selectedNode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleDismissCard();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNode, handleDismissCard]);

  const handleSelectPreset = useCallback((preset: CameraPreset) => {
    setActivePreset(preset.id);
    engineRef.current?.flyTo(preset.lat, preset.lon, preset.distance);
  }, []);

  const quoteHref = selectedNode ? buildQuoteUrlForNode(selectedNode) : '/quote';

  return (
    <div
      className={`relative w-full h-[440px] md:h-[540px] rounded-lg border border-slate-800 bg-bro-obsidian overflow-hidden shadow-2xl select-none ${className}`}
      aria-label="Interactive 3D North American Freight Corridor and Border Command Globe"
    >
      {/* WebGL Canvas Host */}
      <div
        ref={containerRef}
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* Graceful WebGL Context-Lost / Unavailable Fallback */}
      {webglFallback && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-bro-obsidian/95 p-6 text-center">
          <Compass className="w-8 h-8 text-bro-cyan mb-3" aria-hidden="true" />
          <p className="font-mono text-xs uppercase tracking-widest text-bro-cyan font-semibold">
            3D Geospatial Viewport Standby
          </p>
          <p className="mt-2 max-w-md text-xs text-slate-300 leading-relaxed">
            Hardware WebGL acceleration is unavailable in this browser session. All{' '}
            {HUB_LOCATIONS.length} North American hubs, {CORRIDOR_ROUTES.length} active trade
            corridors, and {BORDER_PORTS.length} CBSA/CBP commercial crossings remain operational.
          </p>
          <a
            href="/quote"
            className="mt-4 inline-flex items-center gap-2 rounded border border-bro-cyan/50 bg-bro-cyan/10 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-bro-cyan hover:bg-bro-cyan/20 transition-colors"
          >
            Open Live Rate Engine
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
        </div>
      )}

      {/* Top-Left Camera Preset Bar */}
      <div
        className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Camera corridor presets"
      >
        {CAMERA_PRESETS.map((preset) => {
          const isActive = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleSelectPreset(preset)}
              aria-pressed={isActive}
              className={`px-2.5 py-1.5 rounded border font-mono text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bro-cyan cursor-pointer ${
                isActive
                  ? 'border-bro-cyan/60 bg-bro-cyan/15 text-bro-cyan font-semibold'
                  : 'border-slate-800 bg-bro-obsidian/80 text-slate-300 hover:border-slate-600 hover:text-bro-ice'
              } backdrop-blur-md`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Subtle Hover Readout Chip (when hovering an unselected node) */}
      {hoveredNode && hoveredNode.id !== selectedNode?.id && (
        <div className="pointer-events-none absolute bottom-4 right-4 z-20 hidden sm:flex items-center gap-2 rounded border border-slate-700/80 bg-bro-obsidian/85 backdrop-blur-md px-3 py-1.5 font-mono text-[10px] text-bro-ice">
          <MapPin className="w-3 h-3 text-bro-cyan shrink-0" aria-hidden="true" />
          <span className="font-semibold">
            {hoveredNode.kind === 'border_port' ? hoveredNode.crossingName : hoveredNode.name}
          </span>
          <span className="text-slate-400">· Click to inspect</span>
        </div>
      )}

      {/* Bottom-Left Diagnostic HUD & Wait-Time Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded border border-slate-800/90 bg-bro-obsidian/80 backdrop-blur-md px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-slate-400 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              feedStatus === 'live' ? 'bg-bro-cyan' : 'bg-bro-gold'
            }`}
            aria-hidden="true"
          />
          <span className="text-bro-ice font-semibold">GEOSPATIAL COMMAND GLOBE</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px]">
          <span>
            CORRIDORS: <span className="text-slate-200">{CORRIDOR_ROUTES.length}</span>
          </span>
          <span>
            HUBS: <span className="text-slate-200">{HUB_LOCATIONS.length}</span>
          </span>
          <span>
            PORTS: <span className="text-slate-200">{BORDER_PORTS.length}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Radio className="w-2.5 h-2.5 text-bro-cyan" aria-hidden="true" />
            <span className={feedStatus === 'live' ? 'text-bro-cyan' : 'text-bro-gold'}>
              {feedStatus === 'live'
                ? 'CBSA/CBP LIVE'
                : feedStatus === 'loading'
                  ? 'SYNCING...'
                  : 'TELEMETRY STANDBY'}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-3 border-t border-slate-800/80 pt-1 text-[9px] text-slate-400">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rotate-45 bg-bro-cyan" aria-hidden="true" />
            &lt;15m
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rotate-45 bg-bro-gold" aria-hidden="true" />
            15–45m
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rotate-45 bg-bro-crimson" aria-hidden="true" />
            &gt;45m
          </span>
        </div>
      </div>

      {/* Floating Telemetry Card for Selected Hub or Border Port */}
      {selectedNode && (
        <aside
          role="dialog"
          aria-modal="false"
          aria-label={
            selectedNode.kind === 'border_port'
              ? `Border crossing telemetry for ${selectedNode.crossingName}`
              : `Logistics hub telemetry for ${selectedNode.name}`
          }
          className="absolute top-14 right-3 sm:top-3 sm:right-3 z-20 w-[calc(100%-1.5rem)] sm:w-80 rounded-lg border border-slate-700/90 bg-bro-obsidian/92 backdrop-blur-md p-4 text-left shadow-2xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-widest text-bro-cyan font-semibold">
                {selectedNode.kind === 'border_port'
                  ? `BORDER CROSSING // CBP #${selectedNode.cbpCode}`
                  : selectedNode.isHQ
                    ? 'COMMAND HQ // ATLANTIC GATEWAY'
                    : `LOGISTICS HUB // ${selectedNode.country}`}
              </div>
              <h3 className="mt-1 text-sm font-bold text-bro-ice leading-snug truncate">
                {selectedNode.kind === 'border_port'
                  ? selectedNode.crossingName
                  : selectedNode.name}
              </h3>
              <p className="text-xs text-slate-400 truncate">
                {selectedNode.kind === 'border_port'
                  ? `CBSA: ${selectedNode.cbsaName}`
                  : `${selectedNode.city}, ${selectedNode.region} · ${selectedNode.country}`}
              </p>
            </div>

            <button
              ref={closeButtonRef}
              type="button"
              onClick={handleDismissCard}
              aria-label="Close telemetry card"
              className="rounded border border-slate-800 bg-bro-steel/70 p-1 text-slate-400 hover:border-slate-600 hover:text-bro-ice transition-colors focus-visible:outline-2 focus-visible:outline-bro-cyan cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {selectedNode.kind === 'border_port' ? (
            <BorderPortDetails node={selectedNode} />
          ) : (
            <HubDetails node={selectedNode} />
          )}

          <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-slate-400">
              {formatCoords(selectedNode.lat, selectedNode.lon)}
            </span>
            <a
              href={quoteHref}
              className="inline-flex items-center gap-1.5 rounded border border-bro-gold/50 bg-bro-gold/15 px-3 py-1.5 font-mono text-[11px] font-semibold text-bro-gold hover:bg-bro-gold/25 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bro-gold"
            >
              Quote This Lane →
            </a>
          </div>
        </aside>
      )}
    </div>
  );
}

function BorderPortDetails({
  node,
}: {
  node: Extract<GlobeNode, { kind: 'border_port' }>;
}) {
  const styles = getWaitStatusStyles(node.status);

  return (
    <div className="mt-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-slate-800 bg-bro-steel/60 p-2.5">
          <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-slate-400">
            <Clock className="w-3 h-3 text-bro-cyan" aria-hidden="true" />
            Commercial Wait
          </div>
          <div className={`mt-1 font-mono text-lg font-bold tabular-nums ${styles.valueClass}`}>
            {node.commercialWaitMinutes !== null ? `${node.commercialWaitMinutes} min` : '-- min'}
          </div>
          <span
            className={`mt-1 inline-block rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase ${styles.badgeClass}`}
          >
            {styles.label}
          </span>
        </div>

        <div className="rounded border border-slate-800 bg-bro-steel/60 p-2.5 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-slate-400">
              <Navigation className="w-3 h-3 text-bro-gold" aria-hidden="true" />
              Highway
            </div>
            <div className="mt-1 font-mono text-xs font-semibold text-bro-ice">
              {node.highway}
            </div>
          </div>

          <div className="mt-2">
            {node.commercialFastLane ? (
              <span className="inline-flex items-center gap-1 rounded border border-bro-cyan/40 bg-bro-cyan/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-bro-cyan">
                <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                FAST LANE
              </span>
            ) : (
              <span className="inline-flex items-center rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
                STANDARD LANE
              </span>
            )}
          </div>
        </div>
      </div>

      {node.fastLaneWaitMinutes !== null && (
        <div className="flex items-center justify-between rounded border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5 font-mono text-[10px]">
          <span className="text-slate-400">FAST COMMERCIAL WAIT</span>
          <span className="font-semibold text-bro-cyan tabular-nums">
            {node.fastLaneWaitMinutes} min
          </span>
        </div>
      )}
    </div>
  );
}

function HubDetails({ node }: { node: Extract<GlobeNode, { kind: 'hub' }> }) {
  const connectedLanes = countRoutesForHub(node.id);

  return (
    <div className="mt-3 space-y-2.5">
      <div className="rounded border border-slate-800 bg-bro-steel/60 p-2.5">
        <div className="font-mono text-[9px] uppercase tracking-wider text-slate-400">
          Primary Freight Corridor
        </div>
        <div className="mt-1 text-xs font-medium text-bro-ice leading-snug">
          {node.primaryCorridor}
        </div>
        <div className="mt-1.5 font-mono text-[10px] text-slate-400">
          ACTIVE LINKS: <span className="text-bro-gold font-semibold">{connectedLanes}</span>
        </div>
      </div>

      <div>
        <div className="font-mono text-[9px] uppercase tracking-wider text-slate-400 mb-1.5">
          Commercial Divisions
        </div>
        <div className="flex flex-wrap gap-1.5">
          {node.divisions.map((div) => (
            <span
              key={div}
              className="rounded border border-slate-700 bg-slate-900/80 px-2 py-0.5 font-mono text-[10px] text-slate-200"
            >
              {DIVISION_LABELS[div]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
