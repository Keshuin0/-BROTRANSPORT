import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Clock,
  Compass,
  MapPin,
  Navigation,
  Orbit,
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
  variant?: 'hero' | 'card';
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
        label: 'Clear Flow',
      };
    case 'moderate':
      return {
        badgeClass: 'border-bro-gold/40 bg-bro-gold/10 text-bro-gold',
        valueClass: 'text-bro-gold',
        label: 'Moderate Queue',
      };
    case 'congested':
      return {
        badgeClass: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
        valueClass: 'text-rose-400',
        label: 'Heavy Delay',
      };
    default:
      return {
        badgeClass: 'border-white/15 bg-white/5 text-slate-300',
        valueClass: 'text-slate-200',
        label: 'Standby',
      };
  }
}

function formatCoords(lat: number, lon: number): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

export default function CommandGlobe({ className = '', variant = 'card' }: CommandGlobeProps) {
  const isHero = variant === 'hero';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const [selectedNode, setSelectedNode] = useState<GlobeNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GlobeNode | null>(null);
  const [activePreset, setActivePreset] = useState<CameraPreset['id'] | null>('north_america');
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('loading');
  const [webglFallback, setWebglFallback] = useState(false);
  const [touchOrbitEnabled, setTouchOrbitEnabled] = useState(false);
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const [sheetEntered, setSheetEntered] = useState(false);

  // Track coarse-pointer capability cleanly (handles iPad Pro landscape >= 1024px)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(pointer: coarse)');
    const syncCoarse = () => setIsCoarsePointer(query.matches);
    syncCoarse();
    query.addEventListener('change', syncCoarse);
    return () => query.removeEventListener('change', syncCoarse);
  }, []);

  // Mount & cleanly dispose GlobeEngine (including Astro ClientRouter swap teardown)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let engine: GlobeEngine | null = null;
    try {
      engine = new GlobeEngine({
        container,
        onSelectNode: (node) => {
          setSelectedNode(node);
          if (node) {
            setActivePreset(null);
          }
        },
        onHoverNode: (node) => setHoveredNode(node),
        onContextLost: (lost) => setWebglFallback(lost),
        onUserInteract: () => setActivePreset(null),
      });
      engineRef.current = engine;
    } catch {
      setWebglFallback(true);
    }

    const handleBeforeSwap = () => {
      engine?.dispose();
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    };
    document.addEventListener('astro:before-swap', handleBeforeSwap);

    return () => {
      document.removeEventListener('astro:before-swap', handleBeforeSwap);
      engine?.dispose();
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    };
  }, []);

  // Desktop scroll-linked parallax tilt (hero variant only, gated by reduced motion)
  useEffect(() => {
    if (!isHero || webglFallback || typeof window === 'undefined') return;
    const motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    let rafId: number | null = null;

    const updateScrollTilt = (explicitProgress?: number) => {
      rafId = null;
      const engine = engineRef.current;
      const rootEl = rootRef.current;
      if (!engine || !rootEl) return;

      if (motionQuery?.matches || window.innerWidth < 1024) {
        engine.setScrollProgress(0);
        return;
      }

      if (typeof explicitProgress === 'number' && Number.isFinite(explicitProgress)) {
        engine.setScrollProgress(explicitProgress);
        return;
      }

      const heroScrollRaw = document.documentElement.dataset.heroScroll;
      if (heroScrollRaw !== undefined) {
        const parsed = Number(heroScrollRaw);
        if (Number.isFinite(parsed)) {
          engine.setScrollProgress(parsed);
          return;
        }
      }

      const rect = rootEl.getBoundingClientRect();
      const progress = Math.max(-1, Math.min(1, -rect.top / Math.max(1, rect.height)));
      engine.setScrollProgress(progress);
    };

    const scheduleScrollUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => updateScrollTilt());
    };

    const handleHeroScroll = (event: Event) => {
      const detail = (event as CustomEvent<{ progress?: unknown }>).detail;
      if (detail && typeof detail.progress === 'number' && Number.isFinite(detail.progress)) {
        updateScrollTilt(detail.progress);
      }
    };

    updateScrollTilt();
    window.addEventListener('scroll', scheduleScrollUpdate, { passive: true });
    window.addEventListener('bro:hero-scroll', handleHeroScroll);
    motionQuery?.addEventListener('change', scheduleScrollUpdate);

    const handleBeforeSwap = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener('scroll', scheduleScrollUpdate);
      window.removeEventListener('bro:hero-scroll', handleHeroScroll);
    };
    document.addEventListener('astro:before-swap', handleBeforeSwap);

    return () => {
      document.removeEventListener('astro:before-swap', handleBeforeSwap);
      window.removeEventListener('scroll', scheduleScrollUpdate);
      window.removeEventListener('bro:hero-scroll', handleHeroScroll);
      motionQuery?.removeEventListener('change', scheduleScrollUpdate);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isHero, webglFallback]);

  // Fetch live CBSA/CBP commercial border wait times & hydrate WebGL beacons
  useEffect(() => {
    if (webglFallback) return;

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
  }, [webglFallback]);

  // Escape key closes the telemetry card cleanly
  const handleDismissCard = useCallback(() => {
    setSelectedNode(null);
    setSheetEntered(false);
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

  // Animate sheet entrance & focus close button only when selectedNode.id changes
  const selectedNodeId = selectedNode?.id ?? null;
  useEffect(() => {
    if (!selectedNodeId) {
      setSheetEntered(false);
      return;
    }
    setSheetEntered(false);
    const rafId = requestAnimationFrame(() => {
      setSheetEntered(true);
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(rafId);
  }, [selectedNodeId]);

  const handleSelectPreset = useCallback((preset: CameraPreset) => {
    setActivePreset(preset.id);
    engineRef.current?.flyTo(preset.lat, preset.lon, preset.distance);
  }, []);

  const handleToggleTouchOrbit = useCallback(() => {
    setTouchOrbitEnabled((prev) => {
      const next = !prev;
      engineRef.current?.setTouchOrbitEnabled(next);
      return next;
    });
  }, []);

  const quoteHref = selectedNode ? buildQuoteUrlForNode(selectedNode) : '/quote';

  return (
    <div
      ref={rootRef}
      className={`relative w-full select-none overflow-hidden ${
        isHero
          ? 'h-[460px] sm:h-[520px] lg:h-[680px] bg-transparent'
          : 'h-[460px] md:h-[540px] rounded-2xl surface-ceramic'
      } ${className}`}
      aria-label="Interactive 3D North American Freight Corridor and Border Command Globe"
    >
      {/* WebGL Canvas Host */}
      <div
        ref={containerRef}
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* Graceful WebGL Context-Lost / Unavailable Fallback */}
      {webglFallback && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-bro-obsidian/90 p-6 text-center">
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
            className="mt-4 inline-flex items-center gap-2 rounded-full liquid-glass-pill px-5 py-2.5 text-xs font-semibold text-white hover:border-bro-cyan transition-colors"
          >
            Open Live Rate Engine
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
        </div>
      )}

      {/* Top Floating Liquid Glass Camera Segmented Control */}
      <div
        className={`absolute top-3 sm:top-4 z-20 inline-flex flex-wrap items-center gap-1 max-w-[calc(100%-1.5rem)] rounded-full liquid-glass p-1 ${
          isHero ? 'right-3 sm:right-5 lg:right-8' : 'left-3 sm:left-5'
        }`}
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
              className={`min-h-[44px] sm:min-h-[38px] px-2.5 sm:px-3 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-200 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bro-cyan cursor-pointer ${
                isActive
                  ? 'bg-white text-black font-semibold shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-white/10'
              }`}
            >
              {preset.id === 'atlantic' ? (
                <>
                  <span className="sm:hidden">Atlantic</span>
                  <span className="hidden sm:inline">{preset.label}</span>
                </>
              ) : (
                preset.label
              )}
            </button>
          );
        })}
      </div>

      {/* Bottom Non-Overlapping HUD Stack (Hover Pill + Touch Toggle + Legend Pill) */}
      <div
        className={`pointer-events-none absolute bottom-3 z-20 flex flex-col gap-2 ${
          isHero
            ? 'inset-x-3 sm:inset-x-5 lg:inset-x-auto lg:right-8 items-stretch sm:items-end'
            : 'inset-x-3 sm:inset-x-5 items-stretch sm:items-start'
        }`}
      >
        {/* Subtle Hover Readout Pill (desktop/tablet above legend) */}
        {hoveredNode && hoveredNode.id !== selectedNode?.id && (
          <div
            className={`hidden sm:inline-flex items-center gap-2 rounded-full liquid-glass-pill px-3.5 py-1.5 text-xs text-white ${
              isHero ? 'self-end' : 'self-start'
            }`}
          >
            <MapPin className="w-3.5 h-3.5 text-bro-cyan shrink-0" aria-hidden="true" />
            <span className="font-medium">
              {hoveredNode.kind === 'border_port' ? hoveredNode.crossingName : hoveredNode.name}
            </span>
            <span className="text-slate-300">· Click to inspect</span>
          </div>
        )}

        <div
          className={`flex flex-wrap items-center gap-2 ${
            isHero ? 'justify-between sm:justify-end' : 'justify-between sm:justify-start'
          }`}
        >
          {/* Touch/Mobile/Tablet 3D Orbit Toggle (prevents mobile vertical scroll trap) */}
          <button
            type="button"
            onClick={handleToggleTouchOrbit}
            aria-pressed={touchOrbitEnabled}
            aria-label={
              touchOrbitEnabled
                ? 'Disable 3D touch rotation so vertical page scrolling takes priority'
                : 'Enable 3D touch globe rotation'
            }
            className={`${
              isCoarsePointer ? 'inline-flex' : 'inline-flex lg:hidden'
            } pointer-events-auto min-h-[44px] items-center gap-2 rounded-full px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-[color,background-color,border-color,transform] duration-200 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bro-cyan cursor-pointer ${
              touchOrbitEnabled
                ? 'bg-bro-cyan text-black shadow-sm'
                : 'liquid-glass-pill text-white hover:border-bro-cyan/60'
            }`}
          >
            <Orbit className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{touchOrbitEnabled ? '3D Orbit On' : 'Interact 3D'}</span>
          </button>

          {/* Bottom Floating Liquid Glass Telemetry & Wait-Time Legend Pill */}
          <div className="rounded-2xl liquid-glass px-3.5 sm:px-4 py-2 text-xs text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  feedStatus === 'live' ? 'bg-emerald-400' : 'bg-bro-gold'
                }`}
                aria-hidden="true"
              />
              <span className="text-white font-semibold tracking-tight">
                {feedStatus === 'live'
                  ? 'CBP / CBSA Live'
                  : feedStatus === 'loading'
                    ? 'Syncing...'
                    : 'Orbital Standby'}
              </span>
            </div>

            <span className="text-slate-400 hidden sm:inline" aria-hidden="true">
              |
            </span>

            <div className="hidden sm:flex items-center gap-3 font-mono text-xs tabular-nums text-slate-300">
              <span>{CORRIDOR_ROUTES.length} Lanes</span>
              <span>{BORDER_PORTS.length} Crossings</span>
            </div>

            <div className="flex items-center gap-2.5 font-mono text-xs text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-bro-cyan" aria-hidden="true" />
                &lt;15m
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-bro-gold" aria-hidden="true" />
                15–45m
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-bro-crimson" aria-hidden="true" />
                &gt;45m
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Liquid Glass Telemetry Sheet for Selected Hub or Border Port */}
      {selectedNode && (
        <aside
          role="dialog"
          aria-modal="false"
          aria-label={
            selectedNode.kind === 'border_port'
              ? `Border crossing telemetry for ${selectedNode.crossingName}`
              : `Logistics hub telemetry for ${selectedNode.name}`
          }
          className={`absolute top-16 sm:top-20 z-30 w-[calc(100%-1.5rem)] sm:w-80 max-h-[calc(100%-6.5rem)] overflow-y-auto rounded-2xl liquid-glass p-4 text-left transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none motion-reduce:translate-y-0 ${
            isHero ? 'right-3 sm:right-5 lg:right-8' : 'right-3 sm:right-5'
          } ${sheetEntered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-bro-cyan font-semibold">
                <Radio className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {selectedNode.kind === 'border_port'
                    ? `Port #${selectedNode.cbpCode}`
                    : selectedNode.isHQ
                      ? 'HQ · Atlantic Gateway'
                      : `Hub · ${selectedNode.country}`}
                </span>
              </div>
              <h3 className="mt-1 text-base font-display font-semibold text-white leading-snug truncate">
                {selectedNode.kind === 'border_port'
                  ? selectedNode.crossingName
                  : selectedNode.name}
              </h3>
              <p className="text-xs text-slate-300 truncate">
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
              className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-white/10 text-slate-300 hover:bg-white/20 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-bro-cyan cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          {selectedNode.kind === 'border_port' ? (
            <BorderPortDetails node={selectedNode} />
          ) : (
            <HubDetails node={selectedNode} />
          )}

          <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-slate-300 tabular-nums">
              {formatCoords(selectedNode.lat, selectedNode.lon)}
            </span>
            <a
              href={quoteHref}
              className="inline-flex items-center gap-1.5 rounded-full bg-white text-black px-4 py-2 text-xs font-semibold hover:bg-bro-cyan transition-[color,background-color,border-color,transform] duration-200 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bro-cyan shrink-0"
            >
              Quote Lane
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
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
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-xl border border-white/10 bg-[#0b1120] p-3">
          <div className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-slate-300">
            <Clock className="w-3.5 h-3.5 text-bro-cyan shrink-0" aria-hidden="true" />
            <span>Wait</span>
          </div>
          <div className={`mt-1 font-mono text-lg font-bold tabular-nums ${styles.valueClass}`}>
            {node.commercialWaitMinutes !== null ? `${node.commercialWaitMinutes} min` : '-- min'}
          </div>
          <span
            className={`mt-1.5 inline-block rounded-lg border px-2 py-0.5 font-mono text-xs font-semibold ${styles.badgeClass}`}
          >
            {styles.label}
          </span>
        </div>

        <div className="rounded-xl border border-white/10 bg-[#0b1120] p-3 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-slate-300">
              <Navigation className="w-3.5 h-3.5 text-bro-gold shrink-0" aria-hidden="true" />
              <span>Highway</span>
            </div>
            <div className="mt-1 font-mono text-xs font-semibold text-bro-ice">
              {node.highway}
            </div>
          </div>

          <div className="mt-2">
            {node.commercialFastLane ? (
              <span className="inline-flex items-center gap-1 rounded-lg border border-bro-cyan/40 bg-bro-cyan/10 px-2 py-0.5 font-mono text-xs font-semibold text-bro-cyan">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                FAST
              </span>
            ) : (
              <span className="inline-flex items-center rounded-lg border border-white/10 bg-[#0b1120] px-2 py-0.5 font-mono text-xs text-slate-300">
                Standard
              </span>
            )}
          </div>
        </div>
      </div>

      {node.fastLaneWaitMinutes !== null && (
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#0b1120] px-3 py-2 font-mono text-xs">
          <span className="text-slate-300">FAST Commercial Wait</span>
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
      <div className="rounded-xl border border-white/10 bg-[#0b1120] p-3">
        <div className="font-mono text-xs uppercase tracking-wider text-slate-300">
          Primary Corridor
        </div>
        <div className="mt-1 text-xs font-medium text-bro-ice leading-snug">
          {node.primaryCorridor}
        </div>
        <div className="mt-2 font-mono text-xs text-slate-300">
          Active Links: <span className="text-bro-gold font-semibold">{connectedLanes}</span>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-[#0b1120] p-3">
        <div className="font-mono text-xs uppercase tracking-wider text-slate-300 mb-2">
          Commercial Divisions
        </div>
        <div className="flex flex-wrap gap-1.5">
          {node.divisions.map((div) => (
            <span
              key={div}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-xs text-slate-200"
            >
              {DIVISION_LABELS[div]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
