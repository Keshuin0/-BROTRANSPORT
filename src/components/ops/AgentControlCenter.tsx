import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Pause,
  Play,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldCheck,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import { UserRoleSchema, type UserRole } from '@bro/contracts';
import { BroWsClient } from '../../lib/wsClient';

interface AgentFinding {
  entityId: string;
  severity: 'warn' | 'critical';
  message: string;
}

interface AgentStatusRow {
  agent: string;
  enabled?: boolean;
  mode?: string;
  type?: string;
  lastRunAt?: number | null;
  findingsCount?: number;
  lastFindings?: AgentFinding[];
  commandsProcessed?: number;
  hitlThreshold?: number;
  hitlVarianceGate?: string;
  error?: string;
}

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
  active: boolean;
  createdAt: number;
}

interface AuditLogRow {
  id: string;
  actorUserId: string | null;
  actorType: 'user' | 'agent' | 'workflow' | 'webhook' | 'system';
  action: string;
  entityType: string;
  entityId: string;
  detailJson: string | null;
  createdAt: number;
}

const ALL_ROLES: readonly UserRole[] = UserRoleSchema.options;
const CONTROLLABLE_AGENTS = new Set(['CustomsPreFlightAgent', 'FleetWatchdogAgent']);

const AGENT_DESCRIPTIONS: Record<string, string> = {
  CustomsPreFlightAgent:
    'Durable Object Alarm (15m) auditing IN_TRANSIT cross-border loads for ACE/ACI manifests, CARM Release 2 RPP bond & FDA 2-Hr Prior Notice.',
  FleetWatchdogAgent:
    'Durable Object Alarm (60m) scanning 30-day Driver Medical Cards, CDLs, and Annual DOT/NSC equipment inspections.',
  DispatchCopilotAgent:
    'Deterministic natural-language dispatch router Durable Object. Never mutates financial ledgers autonomously.',
  DocumentProcessingWorkflow:
    'Cloudflare Workflow running Workers AI Vision OCR with mandatory HITL pause below 92% confidence or any OS&D flag.',
  BillingSettlementWorkflow:
    'Cloudflare Workflow assembling factoring packets & invoices with mandatory $0.01 deterministic rate-con variance gate.',
};

function formatUtc(ms: number | null | undefined): string {
  if (!ms) return 'Never run';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

export default function AgentControlCenter() {
  const [agents, setAgents] = useState<AgentStatusRow[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Per-agent busy state
  const [busyAgent, setBusyAgent] = useState<string | null>(null);

  // Local edits for RBAC User Role editor
  const [userDrafts, setUserDrafts] = useState<Record<string, { role: UserRole; active: boolean }>>({});
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Audit log filters
  const [actorFilter, setActorFilter] = useState<'all' | AuditLogRow['actorType']>('all');
  const [auditSearch, setAuditSearch] = useState('');

  const fetchAdminData = useCallback(async () => {
    try {
      const [agentsRes, usersRes, logsRes] = await Promise.all([
        fetch('/api/ops/admin/agents/status'),
        fetch('/api/ops/admin/users'),
        fetch('/api/ops/admin/audit-logs'),
      ]);

      if (!agentsRes.ok || !usersRes.ok || !logsRes.ok) {
        const failedRes = !agentsRes.ok ? agentsRes : !usersRes.ok ? usersRes : logsRes;
        const err = (await failedRes.json().catch(() => ({}))) as { error?: string };
        setBanner({
          kind: 'error',
          text: err.error || `Super Admin API returned HTTP ${failedRes.status}.`,
        });
      }

      if (agentsRes.ok) {
        const aData = (await agentsRes.json()) as { agents: AgentStatusRow[] };
        setAgents(aData.agents || []);
      }

      if (usersRes.ok) {
        const uData = (await usersRes.json()) as { users: AdminUserRow[] };
        const list = uData.users || [];
        setUsers(list);
        const drafts: Record<string, { role: UserRole; active: boolean }> = {};
        for (const u of list) {
          drafts[u.id] = { role: u.role, active: u.active };
        }
        setUserDrafts(drafts);
      }

      if (logsRes.ok) {
        const lData = (await logsRes.json()) as { logs: AuditLogRow[] };
        setAuditLogs(lData.logs || []);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error fetching Super Admin control center.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAdminData();
  }, [fetchAdminData]);

  useEffect(() => {
    const client = new BroWsClient('ops:all', (msg) => {
      if (msg.type === 'AGENT_STATUS_UPDATED') {
        void fetchAdminData();
      }
    });
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [fetchAdminData]);

  const handleAgentAction = async (agentName: string, action: 'run' | 'toggle', enabled?: boolean) => {
    setBusyAgent(agentName);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/admin/agents/${encodeURIComponent(agentName)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(typeof enabled === 'boolean' ? { enabled } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || `Agent command rejected (HTTP ${res.status}).` });
      } else {
        setBanner({
          kind: 'success',
          text:
            action === 'run'
              ? `${agentName} manual audit executed and logged to immutable audit trail.`
              : `${agentName} ${enabled ? 'RESUMED' : 'PAUSED'} and logged to immutable audit trail.`,
        });
        await fetchAdminData();
      }
    } catch {
      setBanner({ kind: 'error', text: `Network error invoking ${agentName}.` });
    } finally {
      setBusyAgent(null);
    }
  };

  const handleSaveUserRole = async (user: AdminUserRow) => {
    const draft = userDrafts[user.id];
    if (!draft) return;
    setBusyUserId(user.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/admin/users/${encodeURIComponent(user.id)}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: draft.role, active: draft.active }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || `Role update failed (HTTP ${res.status}).` });
      } else {
        setBanner({
          kind: 'success',
          text: `Updated ${user.email} -> role '${draft.role}' (${draft.active ? 'ACTIVE' : 'SUSPENDED'}).`,
        });
        await fetchAdminData();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error updating user RBAC role.' });
    } finally {
      setBusyUserId(null);
    }
  };

  const filteredLogs = auditLogs.filter((log) => {
    if (actorFilter !== 'all' && log.actorType !== actorFilter) return false;
    if (!auditSearch.trim()) return true;
    const q = auditSearch.toLowerCase();
    return (
      log.action.toLowerCase().includes(q) ||
      log.entityType.toLowerCase().includes(q) ||
      log.entityId.toLowerCase().includes(q) ||
      (log.detailJson || '').toLowerCase().includes(q)
    );
  });

  const handleBootstrapSeed = async () => {
    setBusyAgent('__seed__');
    setBanner(null);
    try {
      const res = await fetch('/api/ops/admin/bootstrap-seed', { method: 'POST' });
      const data = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Unable to seed reference data.');
      setBanner({
        kind: 'success',
        text: data.message || 'Reference commercial fleet, lanes, and manifests initialized.',
      });
      await fetchAdminData();
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Seed failed.' });
    } finally {
      setBusyAgent(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-gold">
            Super Admin Governance · RBAC · Autonomous Agents
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Autonomous Agent &amp; Security Control Center
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={busyAgent === '__seed__'}
            onClick={() => void handleBootstrapSeed()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-gold/15 border border-bro-gold/40 hover:bg-bro-gold/25 text-xs font-semibold text-bro-gold cursor-pointer disabled:opacity-50 transition-colors"
          >
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            <span>{busyAgent === '__seed__' ? 'Seeding Fleet...' : 'Initialize Fleet Seed'}</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchAdminData()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-xs font-semibold text-white cursor-pointer transition-colors"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            <span>Sync Governance State</span>
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

      {/* Autonomous Agent Governance Grid (All 5 Agents / Workflows) */}
      <section aria-label="Autonomous Agent Governance Grid" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Autonomous Agents &amp; Cloudflare HITL Workflows ({agents.length})
            </h2>
          </div>
          <span className="text-xs text-slate-400">
            All control actions recorded in immutable D1 audit logs
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {loading && agents.length === 0 ? (
            <div className="col-span-full surface-ceramic rounded-2xl p-8 text-center text-xs text-slate-300">
              Querying Durable Object agents and Cloudflare Workflows...
            </div>
          ) : (
            agents.map((ag) => {
              const isControllable = CONTROLLABLE_AGENTS.has(ag.agent);
              const isEnabled = ag.enabled !== false;
              const isBusy = busyAgent === ag.agent;
              const findings = ag.lastFindings || [];

              return (
                <div
                  key={ag.agent}
                  className={`surface-ceramic rounded-2xl p-5 border flex flex-col justify-between gap-4 ${
                    ag.error
                      ? 'border-rose-400/50'
                      : isEnabled
                        ? 'border-bro-cyan/30'
                        : 'border-bro-gold/40'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-display text-sm font-bold text-white">{ag.agent}</h3>
                        <span className="text-xs text-slate-400">
                          {ag.type || (isControllable ? 'Durable Object Alarm' : 'Durable Object Router')}
                        </span>
                      </div>
                      <span
                        className={`px-2.5 py-1 rounded-full border text-xs font-semibold uppercase shrink-0 ${
                          ag.error
                            ? 'bg-rose-950/70 border-rose-400/50 text-rose-200'
                            : isEnabled
                              ? 'bg-emerald-950/70 border-emerald-400/45 text-emerald-200'
                              : 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                        }`}
                      >
                        {ag.error ? 'Unreachable' : isEnabled ? 'Active' : 'Paused'}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">
                      {AGENT_DESCRIPTIONS[ag.agent] || 'Autonomous logistics orchestration service.'}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs pt-1">
                      {ag.lastRunAt !== undefined && (
                        <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10">
                          <div className="text-xs text-slate-400">Last Audit</div>
                          <div className="font-mono text-slate-200 tabular-nums mt-1 truncate">
                            {formatUtc(ag.lastRunAt)}
                          </div>
                        </div>
                      )}
                      {ag.findingsCount !== undefined && (
                        <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10">
                          <div className="text-xs text-slate-400">Findings</div>
                          <div
                            className={`font-semibold tabular-nums mt-1 ${
                              ag.findingsCount > 0 ? 'text-rose-200' : 'text-emerald-200'
                            }`}
                          >
                            {ag.findingsCount} alert(s)
                          </div>
                        </div>
                      )}
                      {ag.commandsProcessed !== undefined && (
                        <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10 sm:col-span-2">
                          <div className="text-xs text-slate-400">Commands Routed</div>
                          <div className="text-bro-cyan font-semibold tabular-nums mt-1">
                            {ag.commandsProcessed.toLocaleString()} deterministic intents
                          </div>
                        </div>
                      )}
                      {ag.hitlThreshold !== undefined && (
                        <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10 sm:col-span-2">
                          <div className="text-xs text-slate-400">HITL Confidence Lock</div>
                          <div className="text-bro-cyan font-semibold tabular-nums mt-1">
                            &gt;= {Math.round(ag.hitlThreshold * 100)}% Auto / &lt;{Math.round(ag.hitlThreshold * 100)}% Human Gate
                          </div>
                        </div>
                      )}
                      {ag.hitlVarianceGate && (
                        <div className="p-3 rounded-xl bg-[#0b1120] border border-white/10 sm:col-span-2">
                          <div className="text-xs text-slate-400">Rate-Con Variance Lock</div>
                          <div className="text-bro-gold font-semibold tabular-nums mt-1">
                            Exact Match ({ag.hitlVarianceGate} tolerance)
                          </div>
                        </div>
                      )}
                    </div>

                    {findings.length > 0 && (
                      <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-400/45 space-y-1.5 max-h-32 overflow-y-auto">
                        {findings.slice(0, 4).map((f, idx) => (
                          <div key={idx} className="flex items-start gap-2 text-xs text-rose-100">
                            <AlertTriangle className="w-3.5 h-3.5 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
                            <span>
                              <strong className="text-white font-mono">{f.entityId}:</strong> {f.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Governance Controls */}
                  <div className="pt-3 border-t border-white/10 flex flex-wrap items-center gap-2">
                    {isControllable ? (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleAgentAction(ag.agent, 'run')}
                          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
                        >
                          <Activity className="w-4 h-4" aria-hidden="true" />
                          <span>{isBusy ? 'Running...' : 'Run Audit Now'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleAgentAction(ag.agent, 'toggle', !isEnabled)}
                          className={`inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl border text-xs font-bold uppercase tracking-wider cursor-pointer disabled:opacity-50 transition-colors ${
                            isEnabled
                              ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold hover:bg-bro-gold/25'
                              : 'bg-emerald-950/70 border-emerald-400/45 text-emerald-200 hover:bg-emerald-900'
                          }`}
                        >
                          {isEnabled ? (
                            <Pause className="w-4 h-4" aria-hidden="true" />
                          ) : (
                            <Play className="w-4 h-4" aria-hidden="true" />
                          )}
                          <span>{isEnabled ? 'Pause' : 'Resume'}</span>
                        </button>
                      </>
                    ) : (
                      <div className="w-full flex flex-wrap items-center justify-between gap-2 min-h-[44px] text-xs text-slate-300">
                        <span className="inline-flex items-center gap-1.5 text-emerald-200 font-medium">
                          <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Enforced HITL / Event-Driven
                        </span>
                        <span className="text-slate-400">Managed Runtime</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* RBAC User Role Editor */}
      <section aria-label="RBAC User Role Editor" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Zero-Trust RBAC User Role Editor ({users.length})
            </h2>
          </div>
          <span className="text-xs text-slate-400">
            Dual-Portal isolation enforced via Better Auth &amp; edge middleware
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">User &amp; Email</th>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3">Assigned RBAC Role</th>
                <th className="px-4 py-3">Account State</th>
                <th className="px-4 py-3 text-right">Apply Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-300">
                    {loading ? 'Loading RBAC directory...' : 'No users found.'}
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const draft = userDrafts[u.id] || { role: u.role, active: u.active };
                  const dirty = draft.role !== u.role || draft.active !== u.active;
                  const isBusy = busyUserId === u.id;
                  return (
                    <tr key={u.id} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3.5">
                        <div className="text-sm font-medium text-white">{u.name}</div>
                        <div className="font-mono text-xs text-slate-400">{u.email}</div>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-slate-300 whitespace-nowrap">
                        {u.organizationId || '—'}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <select
                          aria-label={`RBAC role for ${u.email}`}
                          value={draft.role}
                          onChange={(e) =>
                            setUserDrafts((prev) => ({
                              ...prev,
                              [u.id]: { ...draft, role: e.target.value as UserRole },
                            }))
                          }
                          className="rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[44px] sm:min-h-[40px] font-mono text-xs text-white outline-none"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setUserDrafts((prev) => ({
                              ...prev,
                              [u.id]: { ...draft, active: !draft.active },
                            }))
                          }
                          className={`px-3 py-1.5 min-h-[44px] sm:min-h-[40px] rounded-full border text-xs uppercase font-semibold cursor-pointer transition-colors ${
                            draft.active
                              ? 'bg-emerald-950/70 border-emerald-400/45 text-emerald-200'
                              : 'bg-rose-950/70 border-rose-400/50 text-rose-200'
                          }`}
                        >
                          {draft.active ? 'Active' : 'Suspended'}
                        </button>
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={!dirty || isBusy}
                          onClick={() => void handleSaveUserRole(u)}
                          className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl text-xs font-bold uppercase tracking-wider transition-colors ${
                            dirty
                              ? 'bg-bro-cyan text-bro-obsidian hover:bg-cyan-300 cursor-pointer'
                              : 'bg-white/[0.04] border border-white/10 text-slate-400 cursor-not-allowed'
                          }`}
                        >
                          <Save className="w-4 h-4" aria-hidden="true" />
                          <span>{isBusy ? 'Saving...' : 'Save Role'}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Immutable Security Audit Trail */}
      <section aria-label="Immutable Security Audit Trail" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Immutable Security &amp; Operations Audit Trail ({filteredLogs.length})
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 sm:flex-initial">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="text"
                aria-label="Search audit logs by action, entity, or payload details"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Search action, entity, details..."
                className="w-full sm:w-64 pl-9 pr-3 py-2 min-h-[40px] rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan text-xs text-white placeholder:text-slate-400 outline-none"
              />
            </div>

            <div
              role="group"
              aria-label="Filter audit logs by actor type"
              className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-[#060912] p-1"
            >
              {(['all', 'user', 'agent', 'workflow', 'webhook', 'system'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={actorFilter === kind}
                  onClick={() => setActorFilter(kind)}
                  className={`px-3 py-1.5 min-h-[40px] rounded-lg text-xs font-medium capitalize cursor-pointer transition-colors ${
                    actorFilter === kind
                      ? 'bg-white text-black font-semibold shadow-sm'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {kind}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Timestamp (UTC)</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Payload Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs font-mono">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center font-sans text-slate-300">
                    <Terminal className="w-5 h-5 mx-auto mb-1.5 text-slate-400" aria-hidden="true" />
                    No audit records match the current filter.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-white/[0.03]">
                    <td className="px-4 py-3 text-slate-300 tabular-nums whitespace-nowrap text-xs">
                      {formatUtc(log.createdAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`px-2.5 py-0.5 rounded-full border text-xs uppercase font-semibold ${
                          log.actorType === 'agent'
                            ? 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold'
                            : log.actorType === 'webhook'
                              ? 'bg-bro-cyan/15 border-bro-cyan/40 text-bro-cyan'
                              : log.actorType === 'user'
                                ? 'bg-indigo-950/70 border-indigo-400/40 text-indigo-200'
                                : 'bg-slate-800 border-slate-600 text-slate-200'
                        }`}
                      >
                        {log.actorType}
                      </span>
                      {log.actorUserId && (
                        <div className="text-xs text-slate-400 mt-1">{log.actorUserId}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-bold text-white whitespace-nowrap">{log.action}</td>
                    <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                      <span className="text-slate-400">{log.entityType}/</span>
                      {log.entityId}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300 max-w-md truncate" title={log.detailJson || ''}>
                      {log.detailJson || '—'}
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
