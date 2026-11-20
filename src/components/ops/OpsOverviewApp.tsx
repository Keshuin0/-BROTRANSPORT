import { useState, useEffect, useCallback, type SyntheticEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileSearch,
  Radio,
  Receipt,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Truck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { EquipmentType, LoadDirection, LoadStatus } from '@bro/contracts';
import { BroWsClient, type WsEventMessage } from '../../lib/wsClient';

interface OverviewCounts {
  activeLoads: number;
  atBorder: number;
  pendingOcrDocs: number;
  pendingBillingApprovals: number;
  openEscalations: number;
  expiringCompliance: number;
}

interface OverviewLoad {
  id: string;
  loadNumber: string;
  shipperOrgId: string;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  status: LoadStatus;
  commodity: string;
  weightLbs: number;
  rateCustomerCents: number;
  currency: 'CAD' | 'USD';
  updatedAt: number;
}

interface EscalationRecord {
  id: string;
  incidentRef: string;
  category: 'border_hold' | 'cold_chain_excursion' | 'roadside_intercept' | 'urgent_capacity';
  severity: 'high' | 'critical';
  loadReference: string | null;
  contactName: string;
  contactChannel: string;
  summary: string;
  status: 'open' | 'acknowledged' | 'resolved';
  assignedTo: string | null;
  slaDeadline: number;
  resolvedAt: number | null;
  createdAt: number;
}

interface CopilotResponse {
  intent: string;
  requiresConfirmation: boolean;
  suggestedRoute: string;
  summary: string;
}

interface LiveToast {
  id: string;
  type: string;
  detail: string;
  timestamp: number;
}

function formatCents(cents: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  const abs = Math.abs(cents);
  const formatted = (abs / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}$${formatted} ${currency}`;
}

function formatTimeAgo(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function formatSlaRemaining(deadlineMs: number, status: EscalationRecord['status']): { label: string; breached: boolean } {
  if (status === 'resolved') return { label: 'RESOLVED', breached: false };
  const diffMin = Math.round((deadlineMs - Date.now()) / 60_000);
  if (diffMin <= 0) return { label: `BREACHED (${Math.abs(diffMin)}m)`, breached: true };
  return { label: `${diffMin}m left`, breached: false };
}

const STATUS_BADGE: Record<LoadStatus, string> = {
  QUOTED: 'bg-slate-800 text-slate-300 border-slate-700',
  BOOKED: 'bg-sky-950/70 text-sky-300 border-sky-500/30',
  DISPATCHED: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  AT_PICKUP: 'bg-indigo-950/70 text-indigo-300 border-indigo-500/30',
  IN_TRANSIT: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  AT_BORDER: 'bg-bro-gold/15 text-bro-gold border-bro-gold/40',
  CLEARED: 'bg-emerald-950/70 text-emerald-300 border-emerald-500/30',
  AT_DELIVERY: 'bg-teal-950/70 text-teal-300 border-teal-500/30',
  DELIVERED: 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40',
  INVOICED: 'bg-violet-950/70 text-violet-300 border-violet-500/30',
  PAID: 'bg-emerald-950/80 text-emerald-200 border-emerald-400/50',
};

const QUICK_COMMANDS = [
  'quote 38000 reefer PEI to Boston',
  'check Calais border wait times',
  'verify dot 3849201 carrier status',
  'open active cross-border dispatch',
];

export default function OpsOverviewApp() {
  const [counts, setCounts] = useState<OverviewCounts>({
    activeLoads: 0,
    atBorder: 0,
    pendingOcrDocs: 0,
    pendingBillingApprovals: 0,
    openEscalations: 0,
    expiringCompliance: 0,
  });
  const [recentLoads, setRecentLoads] = useState<OverviewLoad[]>([]);
  const [escalations, setEscalations] = useState<EscalationRecord[]>([]);
  const [escFilter, setEscFilter] = useState<'all' | 'open' | 'acknowledged' | 'resolved'>('open');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busyEscId, setBusyEscId] = useState<string | null>(null);

  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [liveFeed, setLiveFeed] = useState<LiveToast[]>([]);
  const [activeToast, setActiveToast] = useState<LiveToast | null>(null);

  const [copilotInput, setCopilotInput] = useState('');
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotResult, setCopilotResult] = useState<CopilotResponse | null>(null);

  const fetchData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [ovRes, escRes] = await Promise.all([
        fetch('/api/ops/overview'),
        fetch('/api/ops/escalations'),
      ]);

      if (!ovRes.ok) {
        const err = (await ovRes.json().catch(() => ({}))) as { error?: string };
        setBanner({ kind: 'error', text: err.error || `Failed to load ops overview (HTTP ${ovRes.status}).` });
      } else {
        const ovData = (await ovRes.json()) as {
          counts: OverviewCounts;
          recentLoads: OverviewLoad[];
          openEscalations: EscalationRecord[];
        };
        setCounts(ovData.counts);
        setRecentLoads(ovData.recentLoads || []);
      }

      if (escRes.ok) {
        const escData = (await escRes.json()) as { escalations: EscalationRecord[] };
        setEscalations(escData.escalations || []);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error communicating with Ops Control Tower API.' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    const client = new BroWsClient(
      'ops:all',
      (msg: WsEventMessage) => {
        if (msg.type === 'CONNECTED' || msg.type === 'PONG') return;
        const summaryText = msg.payload
          ? Object.entries(msg.payload)
              .slice(0, 3)
              .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
              .join(' · ')
          : 'Telemetry frame received';
        const toast: LiveToast = {
          id: `${msg.timestamp}-${msg.type}`,
          type: msg.type,
          detail: summaryText,
          timestamp: msg.timestamp || Date.now(),
        };
        setActiveToast(toast);
        setLiveFeed((prev) => [toast, ...prev].slice(0, 12));
        void fetchData();
      },
      (status) => setWsStatus(status),
    );
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [fetchData]);

  const handleEscalationAction = async (id: string, nextStatus: 'acknowledged' | 'resolved') => {
    setBusyEscId(id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/escalations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Unable to update escalation status.' });
      } else {
        setBanner({
          kind: 'success',
          text: `Escalation marked as ${nextStatus.toUpperCase()}.`,
        });
        await fetchData();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error updating escalation.' });
    } finally {
      setBusyEscId(null);
    }
  };

  const handleCopilotSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const cmd = copilotInput.trim();
    if (!cmd) return;
    setCopilotBusy(true);
    setBanner(null);
    try {
      const res = await fetch('/api/ops/copilot/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const data = (await res.json().catch(() => ({}))) as CopilotResponse & { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Dispatch Co-Pilot command rejected.' });
      } else {
        setCopilotResult(data);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Failed to reach Dispatch Co-Pilot agent.' });
    } finally {
      setCopilotBusy(false);
    }
  };

  const filteredEscalations = escalations.filter((item) =>
    escFilter === 'all' ? true : item.status === escFilter,
  );

  const kpiCards = [
    {
      label: 'Active Loads',
      value: counts.activeLoads,
      href: '/ops/dispatch',
      accent: 'text-bro-cyan border-bro-cyan/30',
      icon: Truck,
      sub: 'Non-settled freight in motion',
    },
    {
      label: 'At Border',
      value: counts.atBorder,
      href: '/ops/customs',
      accent: 'text-bro-gold border-bro-gold/35',
      icon: Radio,
      sub: 'CBP ACE / CBSA ACI crossings',
    },
    {
      label: 'Pending AI OCR Docs',
      value: counts.pendingOcrDocs,
      href: '/ops/documents',
      accent: counts.pendingOcrDocs > 0 ? 'text-bro-gold border-bro-gold/35' : 'text-emerald-400 border-emerald-500/30',
      icon: FileSearch,
      sub: 'Awaiting HITL verification',
    },
    {
      label: 'Pending Billing Approvals',
      value: counts.pendingBillingApprovals,
      href: '/ops/billing',
      accent: counts.pendingBillingApprovals > 0 ? 'text-bro-gold border-bro-gold/35' : 'text-emerald-400 border-emerald-500/30',
      icon: Receipt,
      sub: 'Ready for factoring packet',
    },
    {
      label: 'Open Escalations',
      value: counts.openEscalations,
      href: '#escalations',
      accent: counts.openEscalations > 0 ? 'text-bro-crimson border-bro-crimson/40' : 'text-emerald-400 border-emerald-500/30',
      icon: AlertTriangle,
      sub: 'Priority Ally SLA queue',
    },
    {
      label: 'Expiring Compliance <30d',
      value: counts.expiringCompliance,
      href: '/ops/fleet',
      accent: counts.expiringCompliance > 0 ? 'text-bro-crimson border-bro-crimson/40' : 'text-emerald-400 border-emerald-500/30',
      icon: ShieldAlert,
      sub: 'Medical cards & NSC/DOT',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Command Header Strip */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-cyan">
            PORTAL 2 // LIVE TELEMETRY & DISPATCH ORCHESTRATION
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            Operations Control Tower
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border font-mono text-[11px] uppercase ${
              wsStatus === 'connected'
                ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                : wsStatus === 'connecting'
                  ? 'bg-bro-gold/10 border-bro-gold/35 text-bro-gold'
                  : 'bg-slate-900 border-slate-700 text-slate-400'
            }`}
          >
            {wsStatus === 'connected' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            <span>OpsHub WS: {wsStatus}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchData(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 text-xs font-mono text-bro-ice transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
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
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Dismiss message"
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Live WebSocket Event Toast */}
      {activeToast && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-bro-cyan/10 border border-bro-cyan/40 text-bro-ice"
        >
          <div className="flex items-center gap-2.5 min-w-0 font-mono text-xs">
            <Activity className="w-4 h-4 text-bro-cyan shrink-0" />
            <span className="px-1.5 py-0.5 rounded bg-bro-cyan/20 text-bro-cyan text-[10px] font-bold">
              {activeToast.type}
            </span>
            <span className="truncate text-slate-200">{activeToast.detail}</span>
          </div>
          <button
            type="button"
            onClick={() => setActiveToast(null)}
            aria-label="Dismiss live update"
            className="text-slate-400 hover:text-white cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 6 KPI Cards */}
      <section aria-label="Operational Key Performance Indicators" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <a
              key={card.label}
              href={card.href}
              className={`glass-panel rounded-lg p-4 border transition-colors hover:bg-bro-steel/90 flex flex-col justify-between gap-3 ${card.accent}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  {card.label}
                </span>
                <Icon className="w-4 h-4 shrink-0" />
              </div>
              <div className="text-3xl font-bold font-mono tabular-nums text-white">
                {loading ? '—' : card.value}
              </div>
              <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                <span className="truncate">{card.sub}</span>
                <ArrowRight className="w-3 h-3 shrink-0 text-slate-500" />
              </div>
            </a>
          );
        })}
      </section>

      {/* Quick Dispatch Co-Pilot Command Bar */}
      <section aria-label="Dispatch Co-Pilot Command" className="glass-panel rounded-lg p-4 sm:p-5 border border-bro-cyan/25">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-bro-gold" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Dispatch Co-Pilot Deterministic Router
            </h2>
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            Zero autonomous financial mutations · Routes intents cleanly to verified workflows
          </span>
        </div>

        <form onSubmit={handleCopilotSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            value={copilotInput}
            onChange={(e) => setCopilotInput(e.target.value)}
            placeholder='Enter dispatch command (e.g. "quote 38000 reefer PEI to Boston", "border Calais", "dot 3849201")'
            aria-label="Dispatch Co-Pilot command input"
            className="flex-1 bg-bro-obsidian/90 border border-white/15 focus:border-bro-cyan rounded px-3.5 py-2.5 text-sm font-mono text-white placeholder-slate-500 outline-none"
          />
          <button
            type="submit"
            disabled={copilotBusy || !copilotInput.trim()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            {copilotBusy ? 'Routing...' : 'Execute'}
          </button>
        </form>

        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {QUICK_COMMANDS.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => setCopilotInput(sample)}
              className="px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 font-mono text-[10px] text-slate-300 transition-colors cursor-pointer"
            >
              {sample}
            </button>
          ))}
        </div>

        {copilotResult && (
          <div className="mt-4 p-3.5 rounded-lg bg-bro-obsidian/80 border border-bro-gold/35 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="px-2 py-0.5 rounded bg-bro-gold/15 text-bro-gold font-bold">
                  {copilotResult.intent}
                </span>
                {copilotResult.requiresConfirmation && (
                  <span className="px-2 py-0.5 rounded bg-amber-950/70 text-amber-300 border border-amber-500/30 text-[10px]">
                    HITL CONFIRMATION REQUIRED
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-200">{copilotResult.summary}</p>
            </div>
            <a
              href={copilotResult.suggestedRoute}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-gold text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-amber-400 transition-colors shrink-0"
            >
              Open {copilotResult.suggestedRoute}
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
      </section>

      {/* Main Split: Ally Escalations + Live Event Feed */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Ally Escalations Action Table */}
        <section
          id="escalations"
          aria-label="Live Ally Escalations"
          className="xl:col-span-2 glass-panel rounded-lg border border-white/10 overflow-hidden"
        >
          <div className="p-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-bro-crimson" />
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                Live Ally Escalations Queue
              </h2>
            </div>
            <div className="flex items-center gap-1 bg-bro-obsidian/70 p-1 rounded border border-white/10">
              {(['open', 'acknowledged', 'resolved', 'all'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setEscFilter(tab)}
                  className={`px-2.5 py-1 rounded font-mono text-[10px] uppercase transition-colors cursor-pointer ${
                    escFilter === tab
                      ? 'bg-bro-cyan/20 text-bro-cyan font-bold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                  <th className="px-4 py-2.5">Ref / Severity</th>
                  <th className="px-4 py-2.5">Issue & Contact</th>
                  <th className="px-4 py-2.5">SLA</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {filteredEscalations.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center font-mono text-slate-500">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 mx-auto mb-1.5" />
                      No escalations matching filter &ldquo;{escFilter}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredEscalations.map((esc) => {
                    const sla = formatSlaRemaining(esc.slaDeadline, esc.status);
                    const isBusy = busyEscId === esc.id;
                    return (
                      <tr key={esc.id} className="hover:bg-white/5">
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <div className="font-mono font-bold text-white">{esc.incidentRef}</div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded font-mono text-[10px] uppercase font-bold ${
                                esc.severity === 'critical'
                                  ? 'bg-bro-crimson/20 text-bro-crimson border border-bro-crimson/40'
                                  : 'bg-bro-gold/15 text-bro-gold border border-bro-gold/35'
                              }`}
                            >
                              {esc.severity}
                            </span>
                            <span className="font-mono text-[10px] text-slate-400">
                              {esc.category.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top max-w-md">
                          <p className="text-slate-200 leading-snug">{esc.summary}</p>
                          <div className="mt-1 font-mono text-[10px] text-slate-400">
                            {esc.contactName} · {esc.contactChannel}
                            {esc.loadReference ? ` · Load ${esc.loadReference}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 font-mono text-[11px] tabular-nums ${
                              sla.breached ? 'text-bro-crimson font-bold' : 'text-slate-300'
                            }`}
                          >
                            <Clock className="w-3 h-3" />
                            {sla.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded border font-mono text-[10px] uppercase ${
                              esc.status === 'open'
                                ? 'bg-rose-950/60 border-bro-crimson/40 text-rose-200'
                                : esc.status === 'acknowledged'
                                  ? 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold'
                                  : 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                            }`}
                          >
                            {esc.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {esc.status === 'open' && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleEscalationAction(esc.id, 'acknowledged')}
                                className="px-2.5 py-1 rounded bg-bro-gold/15 hover:bg-bro-gold/25 border border-bro-gold/40 font-mono text-[10px] uppercase text-bro-gold font-bold cursor-pointer disabled:opacity-50"
                              >
                                Acknowledge
                              </button>
                            )}
                            {esc.status !== 'resolved' && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleEscalationAction(esc.id, 'resolved')}
                                className="px-2.5 py-1 rounded bg-emerald-950/70 hover:bg-emerald-900/70 border border-emerald-500/40 font-mono text-[10px] uppercase text-emerald-300 font-bold cursor-pointer disabled:opacity-50"
                              >
                                Resolve
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Real-Time OpsHub Event Feed */}
        <section aria-label="Live OpsHub Telemetry Stream" className="glass-panel rounded-lg border border-white/10 flex flex-col">
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-bro-cyan" />
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                OpsHub Live Feed (ops:all)
              </h2>
            </div>
            <span className="font-mono text-[10px] text-slate-400 tabular-nums">{liveFeed.length} events</span>
          </div>
          <div className="p-3 space-y-2 max-h-80 overflow-y-auto flex-1">
            {liveFeed.length === 0 ? (
              <div className="py-10 text-center font-mono text-[11px] text-slate-500 space-y-1">
                <p>Listening on channel <span className="text-bro-cyan">ops:all</span>.</p>
                <p>Status changes, RNS releases, OCR completions & EDI tenders stream here in real time.</p>
              </div>
            ) : (
              liveFeed.map((ev) => (
                <div key={ev.id} className="p-2.5 rounded bg-bro-obsidian/70 border border-white/10 space-y-1">
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                    <span className="text-bro-cyan font-bold">{ev.type}</span>
                    <span className="text-slate-500 tabular-nums">{formatTimeAgo(ev.timestamp)}</span>
                  </div>
                  <p className="font-mono text-[11px] text-slate-300 break-words">{ev.detail}</p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Recent Loads Table */}
      <section aria-label="Recent Loads" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-bro-cyan" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Recent Active Shipments
            </h2>
          </div>
          <a
            href="/ops/dispatch"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-bro-cyan hover:text-cyan-300"
          >
            Open Full Dispatch Board <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">Load #</th>
                <th className="px-4 py-2.5">Commodity</th>
                <th className="px-4 py-2.5">Division</th>
                <th className="px-4 py-2.5">Corridor</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Customer Rate</th>
                <th className="px-4 py-2.5 text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs">
              {recentLoads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center font-mono text-slate-500">
                    {loading ? 'Loading shipment telemetry...' : 'No loads recorded in D1 yet.'}
                  </td>
                </tr>
              ) : (
                recentLoads.map((load) => (
                  <tr key={load.id} className="hover:bg-white/5">
                    <td className="px-4 py-3 font-mono font-bold text-white whitespace-nowrap">
                      {load.loadNumber}
                    </td>
                    <td className="px-4 py-3 text-slate-200 max-w-xs truncate">{load.commodity}</td>
                    <td className="px-4 py-3 font-mono text-[11px] uppercase text-slate-300 whitespace-nowrap">
                      {load.equipmentType.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] uppercase text-slate-400 whitespace-nowrap">
                      {load.direction.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold ${STATUS_BADGE[load.status]}`}>
                        {load.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-right tabular-nums text-white whitespace-nowrap">
                      {formatCents(load.rateCustomerCents, load.currency)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-right tabular-nums text-slate-400 whitespace-nowrap">
                      {formatTimeAgo(load.updatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
