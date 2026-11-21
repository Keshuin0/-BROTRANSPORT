import { useState, useEffect, useCallback, type SyntheticEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  FileText,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import type { LoadStatus } from '@bro/contracts';

interface EscalationRow {
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

interface ShiftHandoffRow {
  id: string;
  shiftWindow: string;
  outgoingUserId: string;
  summaryMarkdown: string;
  openEscalationIdsJson: string;
  createdAt: number;
}

interface LoadRow {
  id: string;
  loadNumber: string;
  status: LoadStatus;
  commodity: string;
  direction: string;
}

export default function EscalationsDesk() {
  const [escalations, setEscalations] = useState<EscalationRow[]>([]);
  const [handoffs, setHandoffs] = useState<ShiftHandoffRow[]>([]);
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [shiftWindow, setShiftWindow] = useState('Night Watch (23:00 - 07:00 AST) -> Morning Dispatch');
  const [summaryMarkdown, setSummaryMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const fetchEscalations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ops/escalations');
      if (res.ok) {
        const data = (await res.json()) as {
          escalations?: EscalationRow[];
          handoffs?: ShiftHandoffRow[];
          loads?: LoadRow[];
        };
        const escList = Array.isArray(data.escalations) ? data.escalations : [];
        const ldList = Array.isArray(data.loads) ? data.loads : [];
        setEscalations(escList);
        setHandoffs(Array.isArray(data.handoffs) ? data.handoffs : []);
        setLoads(ldList);

        if (!summaryMarkdown) {
          const openEsc = escList.filter((e) => e.status !== 'resolved');
          const borderLoads = ldList.filter((l) => l.status === 'AT_BORDER' || l.status === 'IN_TRANSIT');
          setSummaryMarkdown(
            `### Shift Handoff Summary\n` +
              `- **Active Corridor Loads**: ${borderLoads.length} unit(s) rolling or at CBP/CBSA border gates (${borderLoads.map((l) => l.loadNumber).join(', ') || 'None'}).\n` +
              `- **Open / Acknowledged Escalations**: ${openEsc.length} active incident(s).\n` +
              `- **Cold-Chain & Border Watch**: All reefer telemetry within ±0.5°C FSMA tolerance; morning dispatch to confirm Calais/Houlton commercial lane release.`,
          );
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [summaryMarkdown]);

  useEffect(() => {
    void fetchEscalations();
    const onExecuted = () => void fetchEscalations();
    window.addEventListener('bro:agent-action-executed', onExecuted);
    return () => window.removeEventListener('bro:agent-action-executed', onExecuted);
  }, [fetchEscalations]);

  const handleUpdateEscalation = async (id: string, nextStatus: 'acknowledged' | 'resolved') => {
    setBusyId(id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/escalations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update escalation status.');
      }
      setBanner({
        kind: 'success',
        text: `Escalation marked ${nextStatus.toUpperCase()}.`,
      });
      await fetchEscalations();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to update escalation.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handlePublishHandoff = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusyId('handoff');
    setBanner(null);
    try {
      const openIds = escalations.filter((esc) => esc.status !== 'resolved').map((esc) => esc.id);
      const res = await fetch('/api/ops/escalations/handoffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shiftWindow,
          summaryMarkdown,
          openEscalationIds: openIds,
        }),
      });
      const data = (await res.json()) as { error?: string; id?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to publish shift handoff.');
      }
      setBanner({
        kind: 'success',
        text: `Published Shift Handoff Briefing (${shiftWindow}).`,
      });
      await fetchEscalations();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to publish shift handoff.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const openEscalationCopilot = () => {
    window.dispatchEvent(
      new CustomEvent('bro:open-copilot', {
        detail: {
          agentId: 'EscalationResponseAgent',
          prompt: 'Rank open escalations by SLA deadline and draft structured shift handoff briefing.',
        },
      }),
    );
  };

  const openCount = escalations.filter((e) => e.status === 'open').length;
  const ackCount = escalations.filter((e) => e.status === 'acknowledged').length;
  const resolvedCount = escalations.filter((e) => e.status === 'resolved').length;
  const atBorderLoadsCount = loads.filter((l) => l.status === 'AT_BORDER').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-bro-gold">
            <Radio className="w-4 h-4" />
            <span>24/7 Night Operations &amp; Emergency Triage · SLA Containment &amp; Shift Handoff</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-white">
            Priority Escalations &amp; Night Shift Handoff Desk
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
            Triage border holds, cold-chain excursions, and roadside intercepts against 5-minute critical SLAs and publish structured morning shift handoffs for incoming dispatchers.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openEscalationCopilot}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>Ask Escalation Response Agent</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchEscalations()}
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
          <div className="text-xs text-slate-400">Open Unacknowledged Incidents</div>
          <div className="font-display text-2xl font-bold text-rose-400">{openCount}</div>
          <div className="text-[11px] text-slate-400">5-min Critical / 15-min High SLA</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">In Active Containment</div>
          <div className="font-display text-2xl font-bold text-bro-gold">{ackCount}</div>
          <div className="text-[11px] text-slate-400">Acknowledged by Night Watch</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Loads Currently At Border</div>
          <div className="font-display text-2xl font-bold text-bro-cyan">{atBorderLoadsCount}</div>
          <div className="text-[11px] text-slate-400">CBP ACE / CBSA ACI crossings</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Resolved Escalations</div>
          <div className="font-display text-2xl font-bold text-emerald-400">{resolvedCount}</div>
          <div className="text-[11px] text-slate-400">{handoffs.length} shift handoff(s) archived</div>
        </div>
      </div>

      {/* Main Split: Active Escalations + Shift Handoff Publisher */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-400" />
            <span>Live Incident &amp; Ally Escalation Queue ({escalations.length})</span>
          </h2>

          {escalations.length === 0 ? (
            <div className="p-8 rounded-xl border border-white/10 bg-slate-950/60 text-xs text-slate-400 text-center">
              Zero open escalations on the corridor. All active cross-border shipments operating within normal parameters.
            </div>
          ) : (
            <div className="space-y-3">
              {escalations.map((esc) => {
                const isBusy = busyId === esc.id;
                const minsLeft = Math.ceil((esc.slaDeadline - Date.now()) / 60_000);
                return (
                  <div
                    key={esc.id}
                    className="p-4 rounded-2xl border border-white/10 bg-slate-950/80 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-white">{esc.incidentRef}</span>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-[11px] font-mono uppercase border ${
                            esc.severity === 'critical'
                              ? 'bg-rose-950/80 text-rose-200 border-rose-500/50'
                              : 'bg-bro-gold/15 text-bro-gold border-bro-gold/40'
                          }`}
                        >
                          {esc.severity}
                        </span>
                        <span className="px-2 py-0.5 rounded-md bg-white/[0.06] font-mono text-[11px] text-slate-300">
                          {esc.category.replace(/_/g, ' ')}
                        </span>
                        {esc.loadReference && (
                          <span className="font-mono text-xs text-bro-cyan">{esc.loadReference}</span>
                        )}
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 font-mono text-[11px] ${
                          esc.status === 'resolved'
                            ? 'text-emerald-400'
                            : minsLeft < 0
                              ? 'text-rose-400'
                              : 'text-bro-gold'
                        }`}
                      >
                        <Clock className="w-3.5 h-3.5" />
                        {esc.status === 'resolved'
                          ? 'RESOLVED'
                          : minsLeft < 0
                            ? `SLA Breached (${Math.abs(minsLeft)}m ago)`
                            : `SLA: ${minsLeft}m remaining`}
                      </span>
                    </div>

                    <p className="text-xs text-slate-200 leading-relaxed">{esc.summary}</p>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                      <div className="text-[11px] text-slate-400">
                        Contact: <strong className="text-slate-200">{esc.contactName}</strong> ({esc.contactChannel})
                      </div>

                      {esc.status !== 'resolved' && (
                        <div className="flex items-center gap-2">
                          {esc.status === 'open' && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleUpdateEscalation(esc.id, 'acknowledged')}
                              className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-bro-gold/40 bg-bro-gold/15 hover:bg-bro-gold/25 text-xs font-semibold text-bro-gold cursor-pointer transition-colors"
                            >
                              Acknowledge
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleUpdateEscalation(esc.id, 'resolved')}
                            className="min-h-[38px] inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-xs font-semibold text-black cursor-pointer transition-colors"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Mark Resolved</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Shift Handoff Publisher & Archive */}
        <div className="lg:col-span-5 space-y-6">
          <form
            onSubmit={handlePublishHandoff}
            className="surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-bro-cyan" />
              <span>Publish Shift Handoff Briefing</span>
            </h2>

            <div className="space-y-1">
              <label htmlFor="handoff-window" className="block text-xs text-slate-300">
                Shift Transition Window
              </label>
              <input
                id="handoff-window"
                type="text"
                required
                value={shiftWindow}
                onChange={(e) => setShiftWindow(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-950 border border-white/15 text-xs text-white"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="handoff-summary" className="block text-xs text-slate-300">
                Operational Briefing (Markdown / Bullet Points)
              </label>
              <textarea
                id="handoff-summary"
                rows={6}
                required
                minLength={10}
                value={summaryMarkdown}
                onChange={(e) => setSummaryMarkdown(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-white/15 text-xs text-slate-100 font-mono leading-relaxed"
              />
            </div>

            <button
              type="submit"
              disabled={busyId === 'handoff'}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black font-semibold text-xs cursor-pointer transition-colors"
            >
              <Send className="w-4 h-4" />
              <span>{busyId === 'handoff' ? 'Publishing...' : 'Publish Shift Handoff to Control Tower'}</span>
            </button>
          </form>

          {handoffs.length > 0 && (
            <div className="surface-ceramic p-5 rounded-2xl border border-white/10 space-y-3">
              <h3 className="font-display text-sm font-bold text-white">
                Recent Shift Handoff Logs ({handoffs.length})
              </h3>
              <div className="space-y-2.5">
                {handoffs.slice(0, 4).map((h) => (
                  <div
                    key={h.id}
                    className="p-3.5 rounded-xl bg-slate-950/80 border border-white/10 space-y-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between text-[11px] font-mono text-bro-cyan">
                      <span>{h.shiftWindow}</span>
                      <span className="text-slate-400">
                        {new Date(h.createdAt).toISOString().slice(0, 16).replace('T', ' ')}Z
                      </span>
                    </div>
                    <pre className="text-xs text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                      {h.summaryMarkdown}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
