import { useEffect, useMemo, useState } from 'react';
import { Radio, Clock, AlertTriangle, ArrowUpRight } from 'lucide-react';
import type { BorderWaitFeed } from '../../../workers/services/borderWaitTimes';

type FilterMode = 'all' | 'fastest' | 'atlantic' | 'great_lakes';

const ATLANTIC_CODES = new Set(['0115', '0106', '0109', '0712']);
const GREAT_LAKES_CODES = new Set(['3801', '3802', '3800', '0901']);

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
    }
    return filtered.slice(0, 8);
  }, [feed, filter]);

  const severityStyle = (mins: number | null) => {
    if (mins === null) {
      return {
        label: 'Standby',
        pill: 'text-slate-300 bg-white/[0.06] border-white/10',
        bar: 'bg-slate-600 w-1/4',
      };
    }
    if (mins >= 45) {
      return {
        label: 'Heavy Queue',
        pill: 'text-rose-200 bg-rose-500/15 border-rose-400/35',
        bar: 'bg-bro-crimson w-full',
      };
    }
    if (mins >= 15) {
      return {
        label: 'Moderate',
        pill: 'text-amber-200 bg-amber-500/15 border-bro-gold/35',
        bar: 'bg-bro-gold w-2/3',
      };
    }
    return {
      label: 'Clear Flow',
      pill: 'text-cyan-200 bg-cyan-500/15 border-bro-cyan/35',
      bar: 'bg-bro-cyan w-1/3',
    };
  };

  return (
    <div className="rounded-3xl surface-ceramic p-6 sm:p-8 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-bro-cyan">
            <Radio className="w-4 h-4" />
            <span>Live Official CBP &amp; CBSA Telemetry</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-display font-bold text-white tracking-tight">
            Commercial Border Crossing Intelligence
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Apple-style Segmented Filter Control */}
          <div
            role="group"
            aria-label="Filter border crossings"
            className="inline-flex items-center gap-1 p-1 rounded-full bg-white/[0.04] border border-white/[0.08]"
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
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all cursor-pointer ${
                  filter === id
                    ? 'bg-white text-black font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400">
            {feed?.stale && (
              <span className="inline-flex items-center gap-1 text-bro-gold">
                <AlertTriangle className="w-3.5 h-3.5" /> Cached
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] tabular-nums">
              <Clock className="w-3 h-3 text-bro-cyan" />
              {feed ? new Date(feed.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : loading ? 'Syncing' : 'Standby'}
            </span>
            <a
              href="/customs"
              className="inline-flex items-center gap-1 text-xs font-medium text-white hover:text-bro-cyan transition-colors pl-1"
            >
              <span>All 13</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {visiblePorts.map((p) => {
          const maxWait = Math.max(p.southboundCommercialMinutes ?? -1, p.northboundCommercialMinutes ?? -1);
          const displayWait = maxWait >= 0 ? maxWait : null;
          const status = severityStyle(displayWait);

          return (
            <div
              key={p.cbpCode}
              className="p-4 rounded-2xl bg-[#070a14]/90 border border-white/[0.08] hover:border-white/20 transition-colors flex flex-col justify-between space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{p.crossingName}</div>
                  <div className="font-mono text-[10px] text-slate-400 mt-0.5">CBP #{p.cbpCode}</div>
                </div>
                <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium shrink-0 ${status.pill}`}>
                  {status.label}
                </span>
              </div>

              {/* Latency gauge */}
              <div className="h-1 w-full rounded-full bg-white/[0.07] overflow-hidden">
                <div className={`h-full rounded-full transition-all ${status.bar}`} />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-0.5 text-xs">
                <div>
                  <div className="text-[10px] text-slate-400">US-Bound (CBP)</div>
                  <div className="font-mono font-semibold text-white tabular-nums mt-0.5">
                    {p.southboundCommercialMinutes !== null ? `${p.southboundCommercialMinutes} min` : '—'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-400">CA-Bound (CBSA)</div>
                  <div className="font-mono font-semibold text-slate-200 tabular-nums mt-0.5">
                    {p.northboundCommercialMinutes !== null ? `${p.northboundCommercialMinutes} min` : '—'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {!feed && (
          <div className="col-span-full py-8 text-center text-sm text-slate-400">
            {loading
              ? 'Streaming live official CBP XML & CBSA commercial wait times...'
              : 'Live feeds momentarily unavailable. Open the Customs Desk to inspect all 13 crossings.'}
          </div>
        )}
      </div>
    </div>
  );
}
