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
  if (status === 'resolved') return { label: 'Resolved', breached: false };
  const diffMin = Math.round((deadlineMs - Date.now()) / 60_000);
  if (diffMin <= 0) return { label: `Breached (${Math.abs(diffMin)}m)`, breached: true };
  return { label: `${diffMin}m left`, breached: false };
}

const STATUS_BADGE: Record<LoadStatus, string> = {
  QUOTED: 'bg-slate-800 text-slate-200 border-slate-600',
  BOOKED: 'bg-sky-950/70 text-sky-200 border-sky-400/40',
  DISPATCHED: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  AT_PICKUP: 'bg-indigo-950/70 text-indigo-200 border-indigo-400/40',
  IN_TRANSIT: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  AT_BORDER: 'bg-bro-gold/15 text-bro-gold border-bro-gold/40',
  CLEARED: 'bg-emerald-950/70 text-emerald-200 border-emerald-400/40',
  AT_DELIVERY: 'bg-teal-950/70 text-teal-200 border-teal-400/40',
  DELIVERED: 'bg-emerald-950/70 text-emerald-200 border-emerald-400/40',
  INVOICED: 'bg-violet-950/70 text-violet-200 border-violet-400/40',
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

  // Automatic 30s polling fallback when WebSocket connection is offline
  useEffect(() => {
    if (wsStatus !== 'offline') return;
    const timer = window.setInterval(() => {
      void fetchData();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [wsStatus, fetchData]);

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
      accentText: 'text-bro-cyan',
      accentBorder: 'border-bro-cyan/30',
      icon: Truck,
      sub: 'Non-settled freight in motion',
    },
    {
      label: 'At Border',
      value: counts.atBorder,
      href: '/ops/customs',
      accentText: 'text-bro-gold',
      accentBorder: 'border-bro-gold/35',
      icon: Radio,
      sub: 'CBP ACE / CBSA ACI crossings',
    },
    {
      label: 'Pending AI OCR Docs',
      value: counts.pendingOcrDocs,
      href: '/ops/documents',
      accentText: counts.pendingOcrDocs > 0 ? 'text-bro-gold' : 'text-emerald-300',
      accentBorder: counts.pendingOcrDocs > 0 ? 'border-bro-gold/35' : 'border-emerald-400/30',
      icon: FileSearch,
      sub: 'Awaiting HITL verification',
    },
    {
      label: 'Pending Billing Approvals',
      value: counts.pendingBillingApprovals,
      href: '/ops/billing',
      accentText: counts.pendingBillingApprovals > 0 ? 'text-bro-gold' : 'text-emerald-300',
      accentBorder: counts.pendingBillingApprovals > 0 ? 'border-bro-gold/35' : 'border-emerald-400/30',
      icon: Receipt,
      sub: 'Ready for factoring packet',
    },
    {
      label: 'Open Escalations',
      value: counts.openEscalations,
      href: '#escalations',
      accentText: counts.openEscalations > 0 ? 'text-rose-200' : 'text-emerald-300',
      accentBorder: counts.openEscalations > 0 ? 'border-rose-400/50' : 'border-emerald-400/30',
      icon: AlertTriangle,
      sub: 'Priority Ally SLA queue',
    },
    {
      label: 'Expiring Compliance <30d',
      value: counts.expiringCompliance,
      href: '/ops/fleet',
      accentText: counts.expiringCompliance > 0 ? 'text-rose-200' : 'text-emerald-300',
      accentBorder: counts.expiringCompliance > 0 ? 'border-rose-400/50' : 'border-emerald-400/30',
      icon: ShieldAlert,
      sub: 'Medical cards & NSC/DOT',
    },
  ];

  const wsBadgeMeta =
    wsStatus === 'connected'
      ? {
          label: 'OPSHUB LIVE',
          srDescription: 'Real-time WebSocket stream connected on channel ops:all',
          classes: 'bg-emerald-950/60 border-emerald-400/40 text-emerald-200',
          icon: <Wifi className="w-4 h-4 shrink-0 text-emerald-300" aria-hidden="true" />,
        }
      : wsStatus === 'connecting'
        ? {
            label: 'SYNC CONNECTING',
            srDescription: 'Connecting to OpsHub WebSocket stream',
            classes: 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold',
            icon: <RefreshCw className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />,
          }
        : {
            label: 'POLLING SYNC',
            srDescription: 'WebSocket offline; polling operations API every 30 seconds',
            classes: 'bg-[#0b1120] border-white/15 text-slate-300',
            icon: <WifiOff className="w-4 h-4 shrink-0 text-slate-300" aria-hidden="true" />,
          };

  return (
    <div className="space-y-6">
      {/* Command Header Strip */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-cyan">
            Live Telemetry &amp; Dispatch Orchestration
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Operations Control Tower
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="status"
            aria-label={wsBadgeMeta.srDescription}
            className={`inline-flex items-center gap-2 px-3.5 py-2 min-h-[44px] rounded-full border text-xs font-semibold tracking-wide ${wsBadgeMeta.classes}`}
          >
            {wsBadgeMeta.icon}
            <span>{wsBadgeMeta.label}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchData(true)}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>
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

      {/* Live WebSocket Event Toast */}
      {activeToast && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl bg-bro-cyan/10 border border-bro-cyan/35 text-bro-ice"
        >
          <div className="flex items-center gap-2.5 min-w-0 text-xs">
            <Activity className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <span className="px-2.5 py-0.5 rounded-full bg-bro-cyan/20 text-bro-cyan font-mono text-xs font-bold shrink-0">
              {activeToast.type}
            </span>
            <span className="truncate text-slate-200">{activeToast.detail}</span>
          </div>
          <button
            type="button"
            onClick={() => setActiveToast(null)}
            aria-label="Dismiss live update"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer shrink-0 transition-colors"
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
              className={`surface-ceramic rounded-2xl p-5 border transition-colors hover:bg-[#0f172a] flex flex-col justify-between gap-3 ${card.accentBorder}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-300">
                  {card.label}
                </span>
                <Icon className={`w-4 h-4 shrink-0 ${card.accentText}`} aria-hidden="true" />
              </div>
              <div className={`text-3xl font-display font-bold tabular-nums ${card.accentText}`}>
                {loading ? '—' : card.value}
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                <span className="truncate">{card.sub}</span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0 text-slate-300" aria-hidden="true" />
              </div>
            </a>
          );
        })}
      </section>

      {/* Quick Dispatch Co-Pilot Command Bar */}
      <section aria-label="Dispatch Co-Pilot Command" className="surface-ceramic rounded-2xl p-5 sm:p-6 border border-bro-cyan/25 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Dispatch Co-Pilot Deterministic Router
            </h2>
          </div>
          <span className="text-xs text-slate-400">
            Zero autonomous financial mutations · Routes intents cleanly to verified workflows
          </span>
        </div>

        <form onSubmit={handleCopilotSubmit} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={copilotInput}
            onChange={(e) => setCopilotInput(e.target.value)}
            placeholder='Enter dispatch command (e.g. "quote 38000 reefer PEI to Boston", "border Calais", "dot 3849201")'
            aria-label="Dispatch Co-Pilot command input"
            className="flex-1 bg-[#0b1120] border border-white/15 focus:border-bro-cyan rounded-xl px-4 py-2.5 min-h-[44px] text-sm font-mono text-white placeholder:text-slate-400 outline-none"
          />
          <button
            type="submit"
            disabled={copilotBusy || !copilotInput.trim()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            <span>{copilotBusy ? 'Routing...' : 'Execute'}</span>
          </button>
        </form>

        <div className="flex flex-wrap gap-2">
          {QUICK_COMMANDS.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => setCopilotInput(sample)}
              className="px-3.5 py-2 min-h-[40px] rounded-full bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              {sample}
            </button>
          ))}
        </div>

        {copilotResult && (
          <div className="p-4 rounded-xl bg-[#0b1120] border border-bro-gold/35 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-2.5 py-0.5 rounded-full bg-bro-gold/15 text-bro-gold font-mono font-bold">
                  {copilotResult.intent}
                </span>
                {copilotResult.requiresConfirmation && (
                  <span className="px-2.5 py-0.5 rounded-full bg-amber-950/70 text-amber-200 border border-amber-400/40 text-xs font-medium">
                    Human Confirmation Required
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-200">{copilotResult.summary}</p>
            </div>
            <a
              href={copilotResult.suggestedRoute}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-bro-gold text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-amber-400 transition-colors shrink-0"
            >
              <span>Open {copilotResult.suggestedRoute}</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
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
          className="xl:col-span-2 surface-ceramic rounded-2xl overflow-hidden"
        >
          <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base font-bold text-white">
                Live Ally Escalations Queue
              </h2>
            </div>
            <div
              role="group"
              aria-label="Filter escalations by status"
              className="flex flex-wrap items-center gap-1 bg-[#060912] p-1 rounded-full border border-white/10"
            >
              {(['open', 'acknowledged', 'resolved', 'all'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={escFilter === tab}
                  onClick={() => setEscFilter(tab)}
                  className={`px-3.5 py-1.5 min-h-[40px] rounded-full text-xs font-medium capitalize transition-colors cursor-pointer ${
                    escFilter === tab
                      ? 'bg-white text-black font-semibold shadow-sm'
                      : 'text-slate-300 hover:text-white'
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
                <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                  <th className="px-4 py-3">Ref / Severity</th>
                  <th className="px-4 py-3">Issue &amp; Contact</th>
                  <th className="px-4 py-3">SLA</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {filteredEscalations.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-slate-300">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 mx-auto mb-2" aria-hidden="true" />
                      No escalations matching filter &ldquo;{escFilter}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredEscalations.map((esc) => {
                    const sla = formatSlaRemaining(esc.slaDeadline, esc.status);
                    const isBusy = busyEscId === esc.id;
                    return (
                      <tr key={esc.id} className="hover:bg-white/[0.03]">
                        <td className="px-4 py-3.5 align-top whitespace-nowrap">
                          <div className="font-mono font-bold text-white tabular-nums">{esc.incidentRef}</div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span
                              className={`px-2.5 py-0.5 rounded-full text-xs uppercase font-semibold border ${
                                esc.severity === 'critical'
                                  ? 'bg-rose-950/70 text-rose-200 border-rose-400/50'
                                  : 'bg-bro-gold/15 text-bro-gold border-bro-gold/35'
                              }`}
                            >
                              {esc.severity}
                            </span>
                            <span className="text-xs text-slate-400 capitalize">
                              {esc.category.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top max-w-md">
                          <p className="text-sm text-slate-100 leading-snug">{esc.summary}</p>
                          <div className="mt-1.5 text-xs text-slate-400">
                            {esc.contactName} · {esc.contactChannel}
                            {esc.loadReference ? ` · Load ${esc.loadReference}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${
                              sla.breached ? 'text-rose-300 font-bold' : 'text-slate-300'
                            }`}
                          >
                            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                            {sla.label}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 align-top whitespace-nowrap">
                          <span
                            className={`px-2.5 py-1 rounded-full border text-xs uppercase font-semibold ${
                              esc.status === 'open'
                                ? 'bg-rose-950/60 border-rose-400/50 text-rose-200'
                                : esc.status === 'acknowledged'
                                  ? 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold'
                                  : 'bg-emerald-950/60 border-emerald-400/40 text-emerald-200'
                            }`}
                          >
                            {esc.status}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 align-top whitespace-nowrap text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-2">
                            {esc.status === 'open' && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleEscalationAction(esc.id, 'acknowledged')}
                                className="px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-bro-gold/15 hover:bg-bro-gold/25 border border-bro-gold/40 text-xs font-semibold text-bro-gold cursor-pointer disabled:opacity-50 transition-colors"
                              >
                                Acknowledge
                              </button>
                            )}
                            {esc.status !== 'resolved' && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleEscalationAction(esc.id, 'resolved')}
                                className="px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-emerald-950/70 hover:bg-emerald-900/70 border border-emerald-400/45 text-xs font-semibold text-emerald-200 cursor-pointer disabled:opacity-50 transition-colors"
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
        <section aria-label="Live OpsHub Telemetry Stream" className="surface-ceramic rounded-2xl flex flex-col overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base font-bold text-white">
                OpsHub Live Feed
              </h2>
            </div>
            <span className="text-xs text-slate-300 tabular-nums">{liveFeed.length} events</span>
          </div>
          <div className="p-4 space-y-2.5 max-h-96 overflow-y-auto flex-1">
            {liveFeed.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-300 space-y-1.5">
                <p>
                  Listening on channel <span className="font-mono text-bro-cyan">ops:all</span>.
                </p>
                <p className="text-slate-400">
                  Status changes, RNS releases, OCR completions &amp; EDI tenders stream here in real time.
                </p>
              </div>
            ) : (
              liveFeed.map((ev) => (
                <div key={ev.id} className="p-3 rounded-xl bg-[#0b1120] border border-white/10 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono text-bro-cyan font-bold">{ev.type}</span>
                    <span className="text-slate-400 tabular-nums">{formatTimeAgo(ev.timestamp)}</span>
                  </div>
                  <p className="text-xs text-slate-300 break-words font-mono">{ev.detail}</p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Recent Loads Table */}
      <section aria-label="Recent Loads" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Recent Active Shipments
            </h2>
          </div>
          <a
            href="/ops/dispatch"
            className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold text-bro-cyan hover:text-cyan-200 hover:bg-white/[0.04] transition-colors"
          >
            <span>Open Full Dispatch Board</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Load #</th>
                <th className="px-4 py-3">Commodity</th>
                <th className="px-4 py-3">Division</th>
                <th className="px-4 py-3">Corridor</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Customer Rate</th>
                <th className="px-4 py-3 text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {recentLoads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-300">
                    {loading ? 'Loading shipment telemetry...' : 'No loads recorded in D1 yet.'}
                  </td>
                </tr>
              ) : (
                recentLoads.map((load) => (
                  <tr key={load.id} className="hover:bg-white/[0.03]">
                    <td className="px-4 py-3.5 font-mono font-bold text-white whitespace-nowrap tabular-nums">
                      {load.loadNumber}
                    </td>
                    <td className="px-4 py-3.5 text-sm text-slate-200 max-w-xs truncate">{load.commodity}</td>
                    <td className="px-4 py-3.5 text-xs uppercase text-slate-300 whitespace-nowrap">
                      {load.equipmentType.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3.5 text-xs uppercase text-slate-400 whitespace-nowrap">
                      {load.direction.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <span className={`px-2.5 py-1 rounded-full border text-xs font-semibold ${STATUS_BADGE[load.status]}`}>
                        {load.status}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 font-mono text-right tabular-nums font-semibold text-white whitespace-nowrap">
                      {formatCents(load.rateCustomerCents, load.currency)}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-right tabular-nums text-slate-400 whitespace-nowrap">
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
