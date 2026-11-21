import { useState, useEffect, useCallback, useMemo, useRef, type SyntheticEvent } from 'react';
import {
  Bot,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import {
  AGENT_DIRECTORY,
  ROLE_LABELS,
  getAgentsForRole,
  type AgentId,
  type AgentSpec,
  type UserRole,
} from '@bro/contracts';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

interface OpsCopilotDrawerProps {
  currentPath: string;
  userRole: UserRole;
  userName?: string | null;
}

interface AgentActionRecord {
  id: string;
  agentId: string;
  targetRole: string;
  entityType: string;
  entityId: string;
  actionType: string;
  title: string;
  rationale: string;
  payloadJson?: string;
  deterministicPreviewJson?: string | null;
  deterministicPreview?: Record<string, unknown>;
  status: string;
  createdAt: number;
}

interface ChatMessageItem {
  id: string;
  sender: 'user' | 'agent';
  agentName?: string;
  text: string;
  metrics?: Record<string, string | number>;
  timestamp: number;
}

function pickDefaultAgentForRoute(pathname: string, available: AgentSpec[]): AgentId {
  const clean = pathname.split('?')[0]!.toLowerCase();
  const exactMatch = available.find((spec) =>
    spec.primaryRoutes.some((r) => (r === '/ops' ? clean === '/ops' : clean.startsWith(r))),
  );
  if (exactMatch) return exactMatch.id;
  return available[0]?.id ?? 'DispatchCopilotAgent';
}

function safeParsePreview(row: AgentActionRecord): Record<string, unknown> {
  if (row.deterministicPreview && typeof row.deterministicPreview === 'object') {
    return row.deterministicPreview;
  }
  if (!row.deterministicPreviewJson) return {};
  try {
    const parsed: unknown = JSON.parse(row.deterministicPreviewJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

export default function OpsCopilotDrawer({
  currentPath,
  userRole,
  userName,
}: OpsCopilotDrawerProps) {
  const authorizedAgents = useMemo(() => getAgentsForRole(userRole), [userRole]);
  const [open, setOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId>(() =>
    pickDefaultAgentForRoute(currentPath, authorizedAgents),
  );
  const [promptInput, setPromptInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<AgentActionRecord[]>([]);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const { mounted, visible, containerRef } = useModalFocusTrap<HTMLDivElement, HTMLInputElement>({
    open,
    onClose: () => setOpen(false),
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    setSelectedAgentId(pickDefaultAgentForRoute(currentPath, authorizedAgents));
  }, [currentPath, authorizedAgents]);

  const activeSpec: AgentSpec =
    AGENT_DIRECTORY[selectedAgentId] ?? authorizedAgents[0] ?? AGENT_DIRECTORY.DispatchCopilotAgent;

  const fetchPendingActions = useCallback(async () => {
    if (!userRole || userRole === 'visitor') return;
    setActionsLoading(true);
    try {
      const res = await fetch('/api/agents/actions?status=pending');
      if (res.ok) {
        const data = (await res.json()) as { actions?: AgentActionRecord[] };
        setPendingActions(Array.isArray(data.actions) ? data.actions : []);
      }
    } catch {
      // ignore offline or initial fetch error
    } finally {
      setActionsLoading(false);
    }
  }, [userRole]);

  useEffect(() => {
    if (open) {
      void fetchPendingActions();
    }
  }, [open, fetchPendingActions]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onExternalOpen = (e: Event) => {
      const custom = e as CustomEvent<{ agentId?: AgentId; prompt?: string }>;
      if (custom.detail?.agentId && AGENT_DIRECTORY[custom.detail.agentId]) {
        setSelectedAgentId(custom.detail.agentId);
      }
      if (custom.detail?.prompt) {
        setPromptInput(custom.detail.prompt);
      }
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('bro:open-copilot', onExternalOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('bro:open-copilot', onExternalOpen);
    };
  }, []);

  const sendCopilotPrompt = async (messageText: string) => {
    const clean = messageText.trim();
    if (!clean || chatLoading) return;

    setBanner(null);
    const userMsg: ChatMessageItem = {
      id: `msg_${crypto.randomUUID()}`,
      sender: 'user',
      text: clean,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setPromptInput('');
    setChatLoading(true);

    try {
      const res = await fetch(`/api/agents/${selectedAgentId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          message: clean,
          routePath: currentPath,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        reply?: string;
        metricsSummary?: Record<string, string | number>;
        proposals?: AgentActionRecord[];
      };

      if (!res.ok) {
        throw new Error(data.error || 'Agent could not complete request.');
      }

      const agentMsg: ChatMessageItem = {
        id: `msg_${crypto.randomUUID()}`,
        sender: 'agent',
        agentName: activeSpec.name,
        text: data.reply || 'Telemetry analyzed.',
        metrics: data.metricsSummary,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, agentMsg]);
      await fetchPendingActions();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to reach specialist agent.',
      });
    } finally {
      setChatLoading(false);
    }
  };

  const handleFormSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    void sendCopilotPrompt(promptInput);
  };

  const handleActionDecision = async (actionId: string, decision: 'approve' | 'reject') => {
    setBusyActionId(actionId);
    setBanner(null);
    try {
      const res = await fetch(`/api/agents/actions/${actionId}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json()) as {
        error?: string;
        executionSummary?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${decision} action.`);
      }
      setBanner({
        kind: 'success',
        text: data.executionSummary || `Action ${decision === 'approve' ? 'executed' : 'dismissed'}.`,
      });
      setPendingActions((prev) => prev.filter((a) => a.id !== actionId));
      window.dispatchEvent(new CustomEvent('bro:agent-action-executed', { detail: { actionId, decision } }));
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Action decision failed.',
      });
    } finally {
      setBusyActionId(null);
    }
  };

  if (authorizedAgents.length === 0) return null;

  const filteredActions = pendingActions.filter(
    (a) => a.agentId === selectedAgentId || userRole === 'super_admin' || userRole === 'executive',
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${activeSpec.name} AI Assistant`}
        className="min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/10 hover:bg-bro-cyan/20 text-xs font-semibold text-bro-cyan whitespace-nowrap cursor-pointer transition-colors"
      >
        <Bot className="w-4 h-4 shrink-0" />
        <span className="hidden sm:inline">{activeSpec.name}</span>
        <span className="sm:hidden">AI Copilot</span>
        {pendingActions.length > 0 && (
          <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-bro-gold text-black text-[10px] font-bold">
            {pendingActions.length}
          </span>
        )}
      </button>

      {mounted && (
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${activeSpec.name} — Specialist Operations Assistant`}
          className="fixed inset-0 z-[120] flex justify-end"
        >
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-sm bro-modal-backdrop"
            data-visible={visible ? 'true' : 'false'}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <aside
            className="relative z-10 w-full max-w-xl bg-slate-950 border-l border-white/15 h-full flex flex-col justify-between shadow-2xl bro-drawer-panel"
            data-visible={visible ? 'true' : 'false'}
          >
            {/* Header */}
            <div className="p-4 sm:p-5 border-b border-white/10 bg-slate-900/80 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-bro-cyan/15 border border-bro-cyan/40 text-[11px] font-semibold text-bro-cyan">
                      <Sparkles className="w-3 h-3" />
                      {activeSpec.name}
                    </span>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-[11px] text-slate-300">
                      {ROLE_LABELS[userRole]}
                      {userName ? ` · ${userName.split(' ')[0]}` : ''}
                    </span>
                  </div>
                  <h2 className="font-display text-base font-bold text-white truncate">
                    {activeSpec.specialtyTitle}
                  </h2>
                  <p className="text-xs text-slate-400 leading-relaxed">{activeSpec.description}</p>
                </div>

                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close Copilot drawer"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full border border-white/15 bg-white/[0.05] text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Specialist Switcher for Multi-Agent / Admin Users */}
              {authorizedAgents.length > 1 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {authorizedAgents.map((spec) => {
                    const isSelected = spec.id === selectedAgentId;
                    return (
                      <button
                        key={spec.id}
                        type="button"
                        onClick={() => setSelectedAgentId(spec.id)}
                        className={`min-h-[38px] px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-bro-cyan text-black font-semibold'
                            : 'bg-white/[0.05] text-slate-300 border border-white/10 hover:bg-white/10'
                        }`}
                      >
                        {spec.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
              {banner && (
                <div
                  className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
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
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Quick Prompts */}
              <div className="space-y-2">
                <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                  Specialized Task Automations
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {activeSpec.quickPrompts.map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={chatLoading}
                      onClick={() => void sendCopilotPrompt(q)}
                      className="min-h-[44px] text-left px-3.5 py-2.5 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] hover:border-bro-cyan/40 text-xs text-slate-200 flex items-center justify-between gap-2 cursor-pointer transition-colors"
                    >
                      <span>{q}</span>
                      <Sparkles className="w-3.5 h-3.5 text-bro-cyan shrink-0" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Pending Human-in-the-Loop Action Cards */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-bro-gold">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Human-in-the-Loop Action Queue ({filteredActions.length})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void fetchPendingActions()}
                    className="min-h-[36px] inline-flex items-center gap-1 px-2.5 rounded-lg border border-white/10 text-[11px] text-slate-300 hover:text-white cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${actionsLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>

                {filteredActions.length === 0 ? (
                  <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02] text-xs text-slate-400">
                    No pending mutations awaiting approval for {activeSpec.name}. Click a task prompt above to analyze live corridor telemetry and stage action cards.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredActions.map((act) => {
                      const preview = safeParsePreview(act);
                      const isBusy = busyActionId === act.id;
                      return (
                        <div
                          key={act.id}
                          className="p-4 rounded-2xl border border-bro-gold/35 bg-slate-900/90 space-y-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="space-y-1">
                              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-bro-gold/15 text-bro-gold font-mono text-[10px] font-semibold">
                                {act.agentId} · {act.actionType}
                              </span>
                              <h3 className="text-xs sm:text-sm font-semibold text-white">
                                {act.title}
                              </h3>
                            </div>
                          </div>

                          <p className="text-xs text-slate-300 leading-relaxed">{act.rationale}</p>

                          {Object.keys(preview).length > 0 && (
                            <div className="p-2.5 rounded-xl bg-black/50 border border-white/10 grid grid-cols-2 gap-2 text-[11px]">
                              {Object.entries(preview).map(([k, v]) => (
                                <div key={k} className="truncate">
                                  <span className="text-slate-400 capitalize">
                                    {k.replace(/([A-Z])/g, ' $1')}:{' '}
                                  </span>
                                  <span className="font-mono text-slate-100">{String(v)}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleActionDecision(act.id, 'approve')}
                              className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs cursor-pointer transition-colors disabled:opacity-50"
                            >
                              {isBusy ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              )}
                              Approve &amp; Execute
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleActionDecision(act.id, 'reject')}
                              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl border border-rose-500/40 bg-rose-950/30 hover:bg-rose-950/60 text-rose-200 font-medium text-xs cursor-pointer transition-colors disabled:opacity-50"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Dismiss
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Conversation Transcript */}
              <div className="space-y-3">
                <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                  Live Specialist Dialogue
                </div>
                {messages.length === 0 ? (
                  <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02] text-xs text-slate-400">
                    Ask {activeSpec.name} any operational question about your active desk. All financial and compliance mutations remain protected by deterministic validation and Human-in-the-Loop approval.
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`p-3.5 rounded-2xl border text-xs space-y-2 ${
                        m.sender === 'user'
                          ? 'bg-bro-cyan/10 border-bro-cyan/30 text-slate-100 ml-6'
                          : 'bg-slate-900/90 border-white/10 text-slate-200 mr-2'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                        <span>{m.sender === 'user' ? 'Operator Prompt' : m.agentName}</span>
                        <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p className="leading-relaxed whitespace-pre-wrap">{m.text}</p>
                      {m.metrics && Object.keys(m.metrics).length > 0 && (
                        <div className="pt-2 border-t border-white/10 grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {Object.entries(m.metrics).map(([k, v]) => (
                            <div key={k} className="px-2 py-1 rounded-lg bg-black/40">
                              <div className="text-[10px] text-slate-400 capitalize truncate">
                                {k.replace(/([A-Z])/g, ' $1')}
                              </div>
                              <div className="font-mono text-xs font-semibold text-bro-cyan truncate">
                                {String(v)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Footer Input */}
            <form
              onSubmit={handleFormSubmit}
              className="p-4 border-t border-white/10 bg-slate-900/90 flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder={`Ask ${activeSpec.name} (Cmd+J)...`}
                className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-950 border border-white/15 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-bro-cyan"
              />
              <button
                type="submit"
                disabled={chatLoading || !promptInput.trim()}
                className="min-h-[44px] px-4 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50"
              >
                {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                <span>Ask</span>
              </button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
