import React, { useState, useEffect, useRef } from 'react';
import { ShieldAlert, X, Clock, CheckCircle2, PhoneCall, Send } from 'lucide-react';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

interface EscalationResult {
  incidentRef: string;
  slaDeadline: number;
  category: string;
}

export default function AllyEscalationDrawer() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<
    'border_hold' | 'cold_chain_excursion' | 'roadside_intercept' | 'urgent_capacity'
  >('border_hold');
  const [severity, setSeverity] = useState<'high' | 'critical'>('high');
  const [loadReference, setLoadReference] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactChannel, setContactChannel] = useState('');
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<EscalationResult | null>(null);
  const [remainingSec, setRemainingSec] = useState<number>(900);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const { mounted, visible, containerRef } = useModalFocusTrap<HTMLDivElement, HTMLButtonElement>({
    open,
    onClose: () => setOpen(false),
    initialFocusRef: closeBtnRef,
  });

  useEffect(() => {
    if (!ticket) return;
    const interval = window.setInterval(() => {
      const secs = Math.max(0, Math.floor((ticket.slaDeadline - Date.now()) / 1000));
      setRemainingSec(secs);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [ticket]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/escalations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          severity,
          loadReference: loadReference.trim() || undefined,
          contactName,
          contactChannel,
          summary,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        incidentRef?: string;
        slaDeadline?: number;
      };
      if (!res.ok || !data.incidentRef || !data.slaDeadline) {
        throw new Error(data.error || 'Unable to log escalation with dispatch.');
      }
      setTicket({
        incidentRef: data.incidentRef,
        slaDeadline: data.slaDeadline,
        category,
      });
      setRemainingSec(Math.max(0, Math.floor((data.slaDeadline - Date.now()) / 1000)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network escalation error.');
    } finally {
      setSubmitting(false);
    }
  };

  const formatClock = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-3.5 min-h-[44px] whitespace-nowrap shrink-0 rounded-full bg-white text-black hover:bg-bro-cyan text-[11px] sm:text-xs font-semibold tracking-tight transition-colors cursor-pointer shadow-sm"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-600 shrink-0" />
        <span>Request Ally</span>
      </button>

      {mounted && (
        <div
          ref={containerRef}
          className="fixed inset-0 z-[110]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ally-drawer-title"
        >
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-md bro-modal-backdrop"
            data-visible={visible ? 'true' : 'false'}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#090d18]/95 backdrop-blur-2xl border-l border-white/15 p-5 sm:p-6 flex flex-col justify-between z-10 overflow-y-auto shadow-2xl bro-drawer-panel"
            data-visible={visible ? 'true' : 'false'}
          >
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-bro-gold">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                    <span>24/7 Executive Dispatch Desk</span>
                  </div>
                  <h2 id="ally-drawer-title" className="text-lg font-display font-bold text-white">
                    Priority Operational Escalation
                  </h2>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    “A bro in need is a bro indeed.” Direct senior coordinator response within 15 minutes.
                  </p>
                </div>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close escalation drawer"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-white/10 bg-[#0b1120] text-slate-300 hover:text-white hover:border-white/25 transition-colors cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {ticket ? (
                <div className="space-y-5 p-5 rounded-2xl bg-[#0b1120] border border-bro-cyan/30">
                  <div className="flex items-center gap-2.5 text-emerald-400">
                    <CheckCircle2 className="w-5 h-5 shrink-0" />
                    <span className="font-mono text-xs font-bold uppercase tracking-wider">
                      Incident Logged &amp; Routed to Ops Tower
                    </span>
                  </div>
                  <div className="space-y-2.5 font-mono text-xs bg-[#060913] p-4 rounded-xl border border-white/10">
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-400">Incident Ref:</span>
                      <span className="text-bro-cyan font-bold">{ticket.incidentRef}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-400">Priority Queue:</span>
                      <span className="text-white uppercase">{ticket.category.replace(/_/g, ' ')}</span>
                    </div>
                    <div className="flex justify-between items-center pt-2.5 border-t border-white/10">
                      <span className="text-slate-400 flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-bro-gold" /> Response SLA:
                      </span>
                      <span className="text-bro-gold font-bold text-base tabular-nums">
                        {formatClock(remainingSec)}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Your ticket has been persisted in our Operations Command ledger and pushed live via WebSocket to on-duty dispatchers.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setTicket(null);
                      setSummary('');
                      setLoadReference('');
                    }}
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl border border-white/15 bg-[#060913] text-xs font-medium text-slate-200 hover:text-white hover:border-bro-cyan transition-colors cursor-pointer"
                  >
                    Log Another Escalation
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <span className="block font-mono text-[11px] uppercase tracking-wider text-slate-300">
                      Escalation Category
                    </span>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {[
                        { id: 'border_hold', label: 'Border Hold (CBP/CBSA)' },
                        { id: 'cold_chain_excursion', label: 'Reefer Temp Alert' },
                        { id: 'roadside_intercept', label: 'Roadside / Breakdown' },
                        { id: 'urgent_capacity', label: 'Urgent Spot Recovery' },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setCategory(opt.id as typeof category)}
                          className={`min-h-[44px] p-3 rounded-xl border text-left transition-colors cursor-pointer leading-snug ${
                            category === opt.id
                              ? 'border-bro-cyan bg-bro-cyan/15 text-white font-semibold'
                              : 'border-white/10 bg-[#0b1120] text-slate-300 hover:text-white hover:border-white/25'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label htmlFor="esc-severity" className="block font-mono text-[11px] uppercase tracking-wider text-slate-300">
                        Urgency Tier
                      </label>
                      <select
                        id="esc-severity"
                        value={severity}
                        onChange={(e) => setSeverity(e.target.value as 'high' | 'critical')}
                        className="w-full min-h-[44px] bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-bro-cyan transition-colors"
                      >
                        <option value="high">High (15-min SLA)</option>
                        <option value="critical">Critical (Immediate)</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="esc-load" className="block font-mono text-[11px] uppercase tracking-wider text-slate-300">
                        Load / PAPS / PARS #
                      </label>
                      <input
                        id="esc-load"
                        type="text"
                        value={loadReference}
                        onChange={(e) => setLoadReference(e.target.value)}
                        placeholder="BROP-2026-9948"
                        className="w-full min-h-[44px] bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan font-mono transition-colors"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="esc-name" className="block font-mono text-[11px] uppercase tracking-wider text-slate-300">
                      Your Name
                    </label>
                    <input
                      id="esc-name"
                      type="text"
                      required
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      placeholder="Representative or Driver Name"
                      className="w-full min-h-[44px] bg-[#0b1120] border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan transition-colors"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="esc-channel" className="block font-mono text-[11px] uppercase tracking-wider text-slate-300">
                      Direct Callback Phone or Email
                    </label>
                    <input
                      id="esc-channel"
                      type="text"
                      required
                      value={contactChannel}
                      onChange={(e) => setContactChannel(e.target.value)}
                      placeholder="+1 (902) 555-0140 or ops@company.com"
                      className="w-full min-h-[44px] bg-[#0b1120] border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan transition-colors"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="esc-summary" className="block font-mono text-[11px] uppercase tracking-wider text-slate-300">
                      Operational Situation Details
                    </label>
                    <textarea
                      id="esc-summary"
                      rows={3}
                      required
                      minLength={10}
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                      placeholder="Port name, delay reason, trailer temperature reading, or equipment issue..."
                      className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan resize-none transition-colors"
                    />
                  </div>

                  {error && (
                    <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-200 text-xs font-mono">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full min-h-[44px] flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-bro-gold hover:bg-bro-gold/90 text-black text-xs font-bold tracking-tight transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{submitting ? 'Routing to Command Tower...' : 'Dispatch Senior Coordinator'}</span>
                  </button>
                </form>
              )}
            </div>

            <div className="pt-4 mt-6 border-t border-white/10 flex items-center justify-between font-mono text-[11px] text-slate-300">
              <span className="flex items-center gap-1.5">
                <PhoneCall className="w-3.5 h-3.5 text-bro-cyan shrink-0" /> PEI HQ Dispatch Desk
              </span>
              <span className="text-slate-200">SCAC: BROP · 24/7 Live</span>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
