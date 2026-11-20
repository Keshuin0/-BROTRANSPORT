import React, { useEffect, useState } from 'react';
import { Radio, Clock, AlertTriangle } from 'lucide-react';
import type { BorderWaitFeed } from '../../../workers/services/borderWaitTimes';

export default function BorderWaitStrip() {
  const [feed, setFeed] = useState<BorderWaitFeed | null>(null);
  const [loading, setLoading] = useState(true);

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

  const badgeTone = (mins: number | null) => {
    if (mins === null) return 'text-slate-400 border-white/10 bg-bro-obsidian/70';
    if (mins >= 45) return 'text-rose-300 border-rose-500/40 bg-rose-950/40';
    if (mins >= 15) return 'text-bro-gold border-bro-gold/40 bg-amber-950/30';
    return 'text-bro-cyan border-bro-cyan/35 bg-cyan-950/30';
  };

  return (
    <div className="rounded-lg border border-white/10 bg-bro-steel/40 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-white">
          <Radio className="w-4 h-4 text-bro-cyan" />
          <span>01 // Live Official CBP & CBSA Commercial Border Wait Times</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-slate-400">
          {feed?.stale && (
            <span className="inline-flex items-center gap-1 text-bro-gold">
              <AlertTriangle className="w-3 h-3" /> Cached Snapshot
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3 text-bro-cyan" />
            {feed ? `Synced ${new Date(feed.fetchedAt).toLocaleTimeString()}` : loading ? 'Querying CBP/CBSA...' : 'Feed Ready'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {(feed?.ports.slice(0, 8) ?? []).map((p) => {
          const maxWait = Math.max(p.southboundCommercialMinutes ?? -1, p.northboundCommercialMinutes ?? -1);
          const displayWait = maxWait >= 0 ? maxWait : null;
          return (
            <div key={p.cbpCode} className={`p-3 rounded border font-mono text-xs space-y-1.5 ${badgeTone(displayWait)}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-white font-bold truncate">{p.crossingName}</span>
                <span className="text-[10px] opacity-80 shrink-0">#{p.cbpCode}</span>
              </div>
              <div className="flex items-center justify-between text-[11px] tabular-nums">
                <span className="text-slate-400">US-Bound (CBP):</span>
                <span className="font-bold">
                  {p.southboundCommercialMinutes !== null ? `${p.southboundCommercialMinutes} min` : 'N/A'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] tabular-nums">
                <span className="text-slate-400">CA-Bound (CBSA):</span>
                <span className="font-bold">
                  {p.northboundCommercialMinutes !== null ? `${p.northboundCommercialMinutes} min` : 'N/A'}
                </span>
              </div>
            </div>
          );
        })}
        {!feed && (
          <div className="col-span-full py-4 text-center font-mono text-xs text-slate-400">
            {loading ? 'Streaming live official CBP XML & CBSA CSV wait times...' : 'Open /customs to inspect all 13 North American commercial crossings.'}
          </div>
        )}
      </div>
    </div>
  );
}
