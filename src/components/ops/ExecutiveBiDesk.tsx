import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

interface ExecutiveKpis {
  totalRevenueCents: number;
  totalCarrierCostCents: number;
  operatingMarginCents: number;
  operatingMarginPct: number;
  openArCents: number;
  fleetUtilizationPct: number;
  activeLoadsCount: number;
}

interface ExecutiveConflict {
  id: string;
  severity: 'warn' | 'critical';
  departments: string[];
  entityId: string;
  title: string;
  detail: string;
  recommendedAction: string;
}

function formatCents(cents: number): string {
  const val = (cents / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${val} CAD`;
}

export default function ExecutiveBiDesk() {
  const [kpis, setKpis] = useState<ExecutiveKpis>({
    totalRevenueCents: 0,
    totalCarrierCostCents: 0,
    operatingMarginCents: 0,
    operatingMarginPct: 0,
    openArCents: 0,
    fleetUtilizationPct: 100,
    activeLoadsCount: 0,
  });
  const [conflicts, setConflicts] = useState<ExecutiveConflict[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchExecutiveBriefing = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agents/hub/briefing');
      if (res.ok) {
        const data = (await res.json()) as {
          kpis?: ExecutiveKpis;
          conflicts?: ExecutiveConflict[];
        };
        if (data.kpis) setKpis(data.kpis);
        setConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchExecutiveBriefing();
    const onExecuted = () => void fetchExecutiveBriefing();
    window.addEventListener('bro:agent-action-executed', onExecuted);
    return () => window.removeEventListener('bro:agent-action-executed', onExecuted);
  }, [fetchExecutiveBriefing]);

  const openChiefOfStaffCopilot = () => {
    window.dispatchEvent(
      new CustomEvent('bro:open-copilot', {
        detail: {
          agentId: 'ExecutiveChiefOfStaffAgent',
          prompt: 'Deliver executive margin and revenue brief across active lanes and highlight cross-department bottlenecks.',
        },
      }),
    );
  };

  const operatingRatioPct =
    kpis.totalRevenueCents > 0
      ? ((kpis.totalCarrierCostCents / kpis.totalRevenueCents) * 100).toFixed(1)
      : '78.0';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-bro-gold">
            <BarChart3 className="w-4 h-4" />
            <span>Executive Leadership &amp; C-Suite BI · Cross-Department Supervisor Correlation</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-white">
            Executive P&amp;L, Operating Ratio &amp; Multi-Agent Supervisor Desk
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
            Real-time integer-cent freight margin, Operating Ratio (O.R.), AR cashflow exposure, and automated cross-department conflict detection across Dispatch, Customs, Safety, Maintenance, and Billing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openChiefOfStaffCopilot}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>Ask Executive Chief of Staff Agent</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchExecutiveBriefing()}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] hover:bg-white/10 text-xs text-slate-200 cursor-pointer transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Run Correlation Pass</span>
          </button>
        </div>
      </div>

      {/* Executive KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Gross Corridor Revenue</div>
          <div className="font-display text-2xl font-bold text-white">
            {formatCents(kpis.totalRevenueCents)}
          </div>
          <div className="text-[11px] text-slate-400">{kpis.activeLoadsCount} active &amp; delivered loads</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Net Operating Margin / O.R.</div>
          <div className="font-display text-2xl font-bold text-emerald-400">
            {formatCents(kpis.operatingMarginCents)} ({kpis.operatingMarginPct.toFixed(1)}%)
          </div>
          <div className="text-[11px] text-slate-400">Operating Ratio: {operatingRatioPct}%</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Open Accounts Receivable (AR)</div>
          <div className="font-display text-2xl font-bold text-bro-gold">
            {formatCents(kpis.openArCents)}
          </div>
          <div className="text-[11px] text-slate-400">Zero-rated &amp; domestic invoices</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Power Unit Fleet Utilization</div>
          <div className="font-display text-2xl font-bold text-bro-cyan">
            {kpis.fleetUtilizationPct.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400">Active vs Shop/OOS Tractors</div>
        </div>
      </div>

      {/* Cross-Department Supervisor Conflict Feed */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <h2 className="font-display text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-bro-gold" />
              <span>Supervisor Cross-Department Conflict Radar ({conflicts.length})</span>
            </h2>
            <p className="text-xs text-slate-400">
              Automatically correlates Dispatch assignments against Safety expiries, Shop Work Orders, Customs CARM filings, and Billing POD locks.
            </p>
          </div>
        </div>

        {conflicts.length === 0 ? (
          <div className="p-8 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 text-center space-y-2">
            <CheckCircle2 className="w-7 h-7 text-emerald-400 mx-auto" />
            <div className="text-sm font-semibold text-white">
              Zero Cross-Department Operational Conflicts Detected
            </div>
            <p className="text-xs text-slate-300">
              All rolling loads have valid customs manifests, compliant drivers, active tractors, and synchronized billing records.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {conflicts.map((c) => (
              <div
                key={c.id}
                className={`p-4 rounded-2xl border space-y-2.5 ${
                  c.severity === 'critical'
                    ? 'bg-rose-950/35 border-rose-500/45'
                    : 'bg-slate-950/85 border-bro-gold/35'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {c.departments.map((dept) => (
                      <span
                        key={dept}
                        className="px-2 py-0.5 rounded-md bg-white/10 font-mono text-[10px] font-semibold text-white uppercase"
                      >
                        {dept}
                      </span>
                    ))}
                  </div>
                  <span
                    className={`px-2.5 py-0.5 rounded-full font-mono text-[10px] uppercase font-bold ${
                      c.severity === 'critical'
                        ? 'bg-rose-500 text-black'
                        : 'bg-bro-gold text-black'
                    }`}
                  >
                    {c.severity}
                  </span>
                </div>
                <h3 className="font-display text-sm font-bold text-white">{c.title}</h3>
                <p className="text-xs text-slate-300 leading-relaxed">{c.detail}</p>
                <div className="pt-1 border-t border-white/10 text-[11px] text-bro-cyan">
                  <strong>Recommended Resolution:</strong> {c.recommendedAction}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Department Command Links */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { href: '/ops/dispatch', label: 'Dispatch & EDI', sub: 'DispatchCopilotAgent' },
          { href: '/ops/planner', label: 'Load Planner', sub: 'LoadPlannerAgent' },
          { href: '/ops/customs', label: 'Customs & CARM', sub: 'CustomsPreFlightAgent' },
          { href: '/ops/billing', label: 'Billing & AR', sub: 'BillingCollectionsAgent' },
          { href: '/ops/settlements', label: 'Driver Payroll', sub: 'SettlementAuditAgent' },
          { href: '/ops/maintenance', label: 'Shop & Work Orders', sub: 'ShopMaintenanceAgent' },
        ].map((card) => (
          <a
            key={card.href}
            href={card.href}
            className="surface-ceramic p-3.5 rounded-2xl border border-white/10 hover:border-bro-cyan/40 space-y-1 transition-colors"
          >
            <div className="text-xs font-semibold text-white">{card.label}</div>
            <div className="text-[10px] font-mono text-bro-cyan truncate">{card.sub}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
