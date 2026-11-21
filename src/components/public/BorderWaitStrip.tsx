import { useEffect, useMemo, useState } from 'react';
import { Radio, Clock, AlertTriangle, ArrowUpRight } from 'lucide-react';
import type { BorderWaitFeed, PortWaitSnapshot } from '../../../workers/services/borderWaitTimes';

type FilterMode = 'all' | 'fastest' | 'atlantic' | 'great_lakes';

const ATLANTIC_CODES = new Set(['0115', '0106', '0109', '0712', '0212']);
const GREAT_LAKES_CODES = new Set(['3801', '3807', '3802', '3800', '0901', '0906', '0708']);

const PORT_LABEL_OVERRIDES: Readonly<Record<string, { title: string; subtitle: string }>> = {
  '0115': { title: 'Calais / St. Stephen', subtitle: 'St. Stephen 3rd Bridge' },
  '0106': { title: 'Houlton / Woodstock', subtitle: 'I-95 Woodstock Rd' },
  '0712': { title: 'Champlain / Lacolle', subtitle: 'St-Bernard-de-Lacolle, QC' },
  '0212': { title: 'Highgate / St-Armand', subtitle: 'St-Armand / Philipsburg' },
  '0708': { title: 'Alexandria Bay / Lansdowne', subtitle: 'Thousand Islands Crossing' },
  '0901': { title: 'Peace Bridge', subtitle: 'Buffalo, NY / Fort Erie, ON' },
  '0906': { title: 'Queenston-Lewiston', subtitle: 'Lewiston, NY / Queenston, ON' },
  '3801': { title: 'Ambassador Bridge', subtitle: 'Detroit, MI / Windsor, ON' },
  '3807': { title: 'Gordie Howe Bridge', subtitle: 'Detroit, MI / Windsor, ON' },
  '3802': { title: 'Blue Water Bridge', subtitle: 'Port Huron, MI / Sarnia, ON' },
  '3401': { title: 'Pembina / Emerson', subtitle: 'I-29 / MB-75 Corridor' },
  '3004': { title: 'Pacific Highway', subtitle: 'Blaine, WA / Surrey, BC' },
  '2304': { title: 'Laredo World Trade', subtitle: 'Laredo, TX / Nuevo Laredo' },
};

function formatPortLabels(port: PortWaitSnapshot): { title: string; subtitle: string } {
  const override = PORT_LABEL_OVERRIDES[port.cbpCode];
  if (override) return override;

  const parenMatch = port.crossingName.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const identifier = parenMatch[1].trim();
    const baseCorridor = port.crossingName.replace(/\([^)]*\)/g, '').trim();
    return {
      title: identifier,
      subtitle: baseCorridor || `${port.usCityState} / ${port.caCityProv}`,
    };
  }

  return {
    title: port.crossingName,
    subtitle: port.cbsaName || `${port.usCityState} / ${port.caCityProv}`,
  };
}

export default function BorderWaitStrip() {
  const [feed, setFeed] = useState<BorderWaitFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterMode>('all');

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/borders/wait-times', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setFeed(data as BorderWaitFeed);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, []);

  const visiblePorts = useMemo(() => {
    const list = [...(feed?.ports ?? [])];
    const filtered = list.filter((p) => {
      if (filter === 'atlantic') return ATLANTIC_CODES.has(p.cbpCode);
      if (filter === 'great_lakes') return GREAT_LAKES_CODES.has(p.cbpCode);
      return true;
    });
    if (filter === 'fastest') {
      filtered.sort((a, b) => {
        const wa = Math.max(a.southboundCommercialMinutes ?? 999, a.northboundCommercialMinutes ?? 999);
        const wb = Math.max(b.southboundCommercialMinutes ?? 999, b.northboundCommercialMinutes ?? 999);
        return wa - wb;
      });
    } else if (filter === 'all') {
      filtered.sort((a, b) => {
        const score = (p: (typeof list)[number]) =>
          (p.southboundCommercialMinutes !== null ? 2 : 0) + (p.northboundCommercialMinutes !== null ? 1 : 0);
        return score(b) - score(a);
      });
    }
    return filtered.slice(0, 8);
  }, [feed, filter]);

  const severityStyle = (mins: number | null) => {
    if (mins === null) {
      return {
        label: 'Standby',
        pill: 'text-slate-200 bg-white/[0.06] border-white/15',
        barColor: 'bg-slate-500',
        scale: 0.25,
      };
    }
    if (mins >= 45) {
      return {
        label: 'Heavy Queue',
        pill: 'text-rose-200 bg-rose-500/15 border-rose-400/35',
        barColor: 'bg-bro-crimson',
        scale: 1,
      };
    }
    if (mins >= 15) {
      return {
        label: 'Moderate',
        pill: 'text-amber-200 bg-amber-500/15 border-bro-gold/35',
        barColor: 'bg-bro-gold',
        scale: 0.67,
      };
    }
    return {
      label: 'Clear Flow',
      pill: 'text-cyan-200 bg-cyan-500/15 border-bro-cyan/35',
      barColor: 'bg-bro-cyan',
      scale: 0.34,
    };
  };

  return (
    <div className="rounded-3xl surface-ceramic p-5 sm:p-8 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-bro-cyan">
            <Radio className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Live Official CBP &amp; CBSA Telemetry</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-display font-bold text-white tracking-tight">
            Commercial Border Crossing Intelligence
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Apple-style Segmented Filter Control (Wraps cleanly with 44px touch pills) */}
          <div
            role="group"
            aria-label="Filter border crossings"
            className="flex flex-wrap items-center gap-1.5 p-1.5 rounded-2xl sm:rounded-full bg-white/[0.04] border border-white/[0.08] w-full sm:w-auto"
          >
            {(
              [
                ['all', 'All Ports'],
                ['fastest', 'Fastest'],
                ['atlantic', 'Atlantic'],
                ['great_lakes', 'Great Lakes'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                aria-pressed={filter === id}
                className={`min-h-[44px] px-3.5 py-2 rounded-xl sm:rounded-full text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  filter === id
                    ? 'bg-white text-black font-semibold'
                    : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-slate-300">
            {feed?.stale && (
              <span className="inline-flex items-center gap-1 text-bro-gold">
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> Cached
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] tabular-nums">
              <Clock className="w-3.5 h-3.5 text-bro-cyan" aria-hidden="true" />
              {feed ? new Date(feed.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : loading ? 'Syncing' : 'Standby'}
            </span>
            <a
              href="/customs"
              className="min-h-[44px] inline-flex items-center gap-1 px-2 text-xs font-medium text-white hover:text-bro-cyan transition-colors whitespace-nowrap"
            >
              <span>All 13</span>
              <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      <div className="min-h-[280px] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {loading && !feed && (
          <>
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={`border-skel-${idx}`}
                aria-hidden="true"
                className="p-4 rounded-2xl bg-[#070a14]/90 border border-white/[0.08] min-h-[136px] flex flex-col justify-between space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1.5 w-2/3">
                    <div className="h-4 w-3/4 rounded bg-white/[0.07]" />
                    <div className="h-3 w-full rounded bg-white/[0.04]" />
                  </div>
                  <div className="h-5 w-14 rounded-full bg-white/[0.06]" />
                </div>
                <div className="h-1 w-full rounded-full bg-white/[0.07]" />
                <div className="grid grid-cols-2 gap-2">
                  <div className="h-7 rounded bg-white/[0.04]" />
                  <div className="h-7 rounded bg-white/[0.04]" />
                </div>
              </div>
            ))}
            <span className="sr-only">Streaming live official CBP XML and CBSA commercial wait times…</span>
          </>
        )}

        {visiblePorts.map((p) => {
          const maxWait = Math.max(p.southboundCommercialMinutes ?? -1, p.northboundCommercialMinutes ?? -1);
          const displayWait = maxWait >= 0 ? maxWait : null;
          const status = severityStyle(displayWait);
          const labels = formatPortLabels(p);

          return (
            <div
              key={p.cbpCode}
              className="p-4 rounded-2xl bg-[#070a14]/90 border border-white/[0.08] hover:border-white/20 transition-colors flex flex-col justify-between space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white leading-snug">{labels.title}</div>
                  <div className="text-xs text-slate-300 leading-snug mt-0.5">{labels.subtitle}</div>
                  <div className="font-mono text-[11px] text-slate-400 mt-0.5 tabular-nums">CBP #{p.cbpCode}</div>
                </div>
                <span className={`px-2 py-0.5 rounded-full border text-[11px] font-medium shrink-0 ${status.pill}`}>
                  {status.label}
                </span>
              </div>

              {/* GPU-Composited Latency Gauge */}
              <div className="h-1 w-full rounded-full bg-white/[0.07] overflow-hidden">
                <div
                  className={`h-full w-full rounded-full origin-left transition-transform duration-300 ${status.barColor}`}
                  style={{ transform: `scaleX(${status.scale})` }}
                />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-0.5 text-xs">
                <div>
                  <div className="text-[11px] text-slate-300">US-Bound (CBP)</div>
                  <div className="font-mono font-semibold text-white tabular-nums mt-0.5">
                    {p.southboundCommercialMinutes !== null ? `${p.southboundCommercialMinutes} min` : '—'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-300">CA-Bound (CBSA)</div>
                  <div className="font-mono font-semibold text-slate-200 tabular-nums mt-0.5">
                    {p.northboundCommercialMinutes !== null ? `${p.northboundCommercialMinutes} min` : '—'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {!loading && !feed && (
          <div className="col-span-full flex items-center justify-center py-12 text-center text-sm text-slate-300">
            Live feeds momentarily unavailable. Open the Customs Desk to inspect all 13 crossings.
          </div>
        )}
      </div>
    </div>
  );
}
