import { useState, useEffect, useCallback } from 'react';
import {
  ArrowRight,
  Compass,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Truck,
  X,
} from 'lucide-react';
import type { EquipmentType, LoadDirection, LoadStatus } from '@bro/contracts';

interface QuoteRow {
  id: string;
  quoteRef: string;
  equipmentType: EquipmentType;
  originLabel: string;
  originCountry: string;
  destLabel: string;
  destCountry: string;
  distanceKm: number;
  weightLbs: number;
  commodity: string;
  totalCents: number;
  currency: 'CAD' | 'USD';
  recommendedPortCode: string | null;
  status: 'open' | 'booked' | 'expired';
  createdAt: number;
}

interface LoadRow {
  id: string;
  loadNumber: string;
  assignedDriverId: string | null;
  tractorId: string | null;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  status: LoadStatus;
  commodity: string;
  weightLbs: number;
  loadedMiles: number;
  rateCustomerCents: number;
  rateCarrierCents: number;
  currency: 'CAD' | 'USD';
}

interface EquipmentRow {
  id: string;
  unitNumber: string;
  type: 'tractor' | 'dry_van' | 'reefer' | 'flatbed';
  jurisdiction: string;
  status: 'active' | 'maintenance' | 'out_of_service';
}

function formatCents(cents: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  const val = (cents / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${val} ${currency}`;
}

export default function LoadPlannerDesk() {
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [divisionFilter, setDivisionFilter] = useState<'all' | EquipmentType>('all');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const fetchPlanner = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ops/planner');
      if (res.ok) {
        const data = (await res.json()) as {
          quotes?: QuoteRow[];
          loads?: LoadRow[];
          equipment?: EquipmentRow[];
        };
        setQuotes(Array.isArray(data.quotes) ? data.quotes : []);
        setLoads(Array.isArray(data.loads) ? data.loads : []);
        setEquipment(Array.isArray(data.equipment) ? data.equipment : []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPlanner();
    const onExecuted = () => void fetchPlanner();
    window.addEventListener('bro:agent-action-executed', onExecuted);
    return () => window.removeEventListener('bro:agent-action-executed', onExecuted);
  }, [fetchPlanner]);

  const handlePromoteQuote = async (q: QuoteRow) => {
    setBusyId(q.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/planner/promote-quote/${q.id}`, {
        method: 'POST',
      });
      const data = (await res.json()) as { error?: string; loadNumber?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to promote quote.');
      }
      setBanner({
        kind: 'success',
        text: `Promoted quote ${q.quoteRef} into booked dispatch load ${data.loadNumber}.`,
      });
      await fetchPlanner();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to promote quote.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const openPlannerCopilot = () => {
    window.dispatchEvent(
      new CustomEvent('bro:open-copilot', {
        detail: {
          agentId: 'LoadPlannerAgent',
          prompt: 'Rank unassigned booked loads by margin and identify Boston/New England to Atlantic Canada backhaul opportunities.',
        },
      }),
    );
  };

  const openQuotes = quotes.filter((q) => q.status === 'open');
  const unassignedLoads = loads.filter(
    (l) => (l.status === 'BOOKED' || l.status === 'QUOTED') && !l.assignedDriverId,
  );
  const southboundLoads = loads.filter((l) => l.direction === 'ca_to_us' && l.status !== 'PAID');
  const northboundLoads = loads.filter((l) => l.direction === 'us_to_ca' && l.status !== 'PAID');
  const avgRpmCents =
    loads.length > 0
      ? Math.round(
          loads.reduce((acc, l) => acc + l.rateCustomerCents / Math.max(1, l.loadedMiles), 0) /
            loads.length,
        )
      : 385;

  const filteredLoads =
    divisionFilter === 'all' ? loads : loads.filter((l) => l.equipmentType === divisionFilter);

  const equipmentCounts = {
    tractor: equipment.filter((e) => e.type === 'tractor' && e.status === 'active').length,
    dry_van: equipment.filter((e) => e.type === 'dry_van' && e.status === 'active').length,
    reefer: equipment.filter((e) => e.type === 'reefer' && e.status === 'active').length,
    flatbed: equipment.filter((e) => e.type === 'flatbed' && e.status === 'active').length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-bro-cyan">
            <Compass className="w-4 h-4" />
            <span>Network Yield &amp; Capacity Planning · Atlantic Canada &harr; U.S. Corridors</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-white">
            Corridor Load Planner &amp; Backhaul Yield Desk
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
            Balance Northbound/Southbound lane capacity, evaluate Revenue-Per-Mile (RPM) yield in integer cents, and convert high-margin quotes into active dispatch loads.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openPlannerCopilot}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>Ask Load Planner Agent</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchPlanner()}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] hover:bg-white/10 text-xs text-slate-200 cursor-pointer transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`p-4 rounded-xl border text-xs sm:text-sm flex items-center justify-between gap-3 ${
            banner.kind === 'success'
              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/60 border-rose-500/40 text-rose-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-slate-300 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Fleet Average Yield (RPM)</div>
          <div className="font-display text-2xl font-bold text-emerald-400">
            {formatCents(avgRpmCents, 'CAD')}/mi
          </div>
          <div className="text-[11px] text-slate-400">Target floor: $3.40/mi CAD</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Unassigned Booked Loads</div>
          <div className="font-display text-2xl font-bold text-bro-gold">{unassignedLoads.length}</div>
          <div className="text-[11px] text-slate-400">Ready for tractor/driver pairing</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Corridor Directional Balance</div>
          <div className="font-display text-2xl font-bold text-bro-cyan">
            {southboundLoads.length} SB / {northboundLoads.length} NB
          </div>
          <div className="text-[11px] text-slate-400">CA&rarr;US vs US&rarr;CA Backhauls</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Ready Equipment Pool</div>
          <div className="font-display text-2xl font-bold text-white">
            {equipmentCounts.tractor} TRC · {equipmentCounts.reefer + equipmentCounts.dry_van + equipmentCounts.flatbed} TRL
          </div>
          <div className="text-[11px] text-slate-400">
            {equipmentCounts.reefer} Reefer · {equipmentCounts.dry_van} Dry Van · {equipmentCounts.flatbed} Flatbed
          </div>
        </div>
      </div>

      {/* Open Quotes Pipeline + Active Corridor Yield Table */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-bro-gold" />
              <span>Open Rate Quotes Pipeline ({openQuotes.length})</span>
            </h2>
          </div>

          {openQuotes.length === 0 ? (
            <div className="p-6 rounded-xl border border-white/10 bg-slate-950/60 text-xs text-slate-400 text-center">
              No unbooked open rate quotes in pipeline. Create a new quote at <a href="/quote" className="text-bro-cyan underline">/quote</a> to test 1-click load promotion.
            </div>
          ) : (
            <div className="space-y-3">
              {openQuotes.map((q) => {
                const miles = Math.max(50, Math.round(q.distanceKm * 0.621371));
                const rpm = Math.round(q.totalCents / miles);
                return (
                  <div
                    key={q.id}
                    className="p-4 rounded-2xl border border-white/10 bg-slate-950/80 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-bro-cyan">{q.quoteRef}</span>
                      <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] font-mono text-[11px] text-slate-200 uppercase">
                        {q.equipmentType.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-white">
                      {q.originLabel} &rarr; {q.destLabel}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                      <span>{q.distanceKm} km ({miles} mi)</span>
                      <span className="text-emerald-400 font-bold">
                        {formatCents(q.totalCents, q.currency)} ({formatCents(rpm, q.currency)}/mi)
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === q.id}
                      onClick={() => void handlePromoteQuote(q)}
                      className="w-full min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-bro-gold hover:bg-amber-400 text-black font-semibold text-xs cursor-pointer transition-colors"
                    >
                      <span>{busyId === q.id ? 'Booking Load...' : 'Promote Quote to Booked Load'}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Corridor Margin & Backhaul Matching Ledger */}
        <div className="lg:col-span-7 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <Truck className="w-4 h-4 text-bro-cyan" />
              <span>Corridor Yield &amp; Margin Matrix ({filteredLoads.length})</span>
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {(['all', 'reefer', 'dry_van', 'flatbed'] as const).map((div) => (
                <button
                  key={div}
                  type="button"
                  onClick={() => setDivisionFilter(div)}
                  className={`min-h-[36px] px-3 py-1 rounded-full text-xs font-medium capitalize cursor-pointer transition-colors ${
                    divisionFilter === div
                      ? 'bg-white text-black font-semibold'
                      : 'bg-white/[0.04] text-slate-300 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {div.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/10 text-[11px] font-mono uppercase text-slate-400">
                  <th className="py-2.5 pr-3">Load #</th>
                  <th className="py-2.5 px-3">Division / Dir</th>
                  <th className="py-2.5 px-3">Miles</th>
                  <th className="py-2.5 px-3">Revenue (RPM)</th>
                  <th className="py-2.5 px-3">Gross Margin</th>
                  <th className="py-2.5 pl-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {filteredLoads.map((l) => {
                  const rpmCents = Math.round(l.rateCustomerCents / Math.max(1, l.loadedMiles));
                  const costCents =
                    l.rateCarrierCents > 0 ? l.rateCarrierCents : Math.round(l.rateCustomerCents * 0.78);
                  const marginCents = l.rateCustomerCents - costCents;
                  const marginPct =
                    l.rateCustomerCents > 0 ? ((marginCents / l.rateCustomerCents) * 100).toFixed(1) : '0.0';
                  return (
                    <tr key={l.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 pr-3 font-mono font-semibold text-white">{l.loadNumber}</td>
                      <td className="py-3 px-3 text-slate-300">
                        <span className="uppercase font-mono text-[11px]">
                          {l.equipmentType.replace('_', ' ')} · {l.direction.replace(/_/g, '→')}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-200">{l.loadedMiles} mi</td>
                      <td className="py-3 px-3 font-mono text-white">
                        {formatCents(l.rateCustomerCents, l.currency)}{' '}
                        <span className="text-[11px] text-bro-cyan">
                          (${(rpmCents / 100).toFixed(2)}/mi)
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-emerald-400 font-semibold">
                        {formatCents(marginCents, l.currency)} ({marginPct}%)
                      </td>
                      <td className="py-3 pl-3 text-right">
                        <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] font-mono text-[11px] text-slate-200">
                          {l.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
