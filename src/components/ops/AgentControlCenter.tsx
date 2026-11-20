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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-gold">
            MODULE 06 // SUPER ADMIN GOVERNANCE · RBAC · AUTONOMOUS AGENTS
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            Autonomous Agent &amp; Security Control Center
          </h1>
        </div>
        <button
          type="button"
          onClick={() => void fetchAdminData()}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 font-mono text-xs text-white cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Sync Governance State
        </button>
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
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Autonomous Agent Governance Grid (All 5 Agents / Workflows) */}
      <section aria-label="Autonomous Agent Governance Grid" className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-bro-cyan" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Autonomous Agents &amp; Cloudflare HITL Workflows ({agents.length})
            </h2>
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            All control actions recorded in immutable D1 audit_logs
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {loading && agents.length === 0 ? (
            <div className="col-span-full glass-panel rounded-lg p-8 text-center font-mono text-xs text-slate-500">
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
                  className={`glass-panel rounded-lg p-4 border flex flex-col justify-between gap-4 ${
                    ag.error
                      ? 'border-bro-crimson/45'
                      : isEnabled
                        ? 'border-bro-cyan/30'
                        : 'border-bro-gold/40'
                  }`}
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-mono text-xs font-bold text-white">{ag.agent}</h3>
                        <span className="font-mono text-[10px] text-slate-400">
                          {ag.type || (isControllable ? 'Durable Object Alarm' : 'Durable Object Router')}
                        </span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold uppercase shrink-0 ${
                          ag.error
                            ? 'bg-rose-950/70 border-bro-crimson/50 text-rose-200'
                            : isEnabled
                              ? 'bg-emerald-950/70 border-emerald-500/45 text-emerald-300'
                              : 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                        }`}
                      >
                        {ag.error ? 'UNREACHABLE' : isEnabled ? 'ACTIVE' : 'PAUSED'}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">
                      {AGENT_DESCRIPTIONS[ag.agent] || 'Autonomous logistics orchestration service.'}
                    </p>

                    <div className="grid grid-cols-2 gap-2 font-mono text-[10px] pt-1">
                      {ag.lastRunAt !== undefined && (
                        <div className="p-2 rounded bg-bro-obsidian/70 border border-white/10">
                          <div className="text-slate-500 uppercase">Last Audit</div>
                          <div className="text-slate-200 tabular-nums mt-0.5 truncate">{formatUtc(ag.lastRunAt)}</div>
                        </div>
                      )}
                      {ag.findingsCount !== undefined && (
                        <div className="p-2 rounded bg-bro-obsidian/70 border border-white/10">
                          <div className="text-slate-500 uppercase">Findings</div>
                          <div
                            className={`font-bold tabular-nums mt-0.5 ${
                              ag.findingsCount > 0 ? 'text-bro-crimson' : 'text-emerald-300'
                            }`}
                          >
                            {ag.findingsCount} alert(s)
                          </div>
                        </div>
                      )}
                      {ag.commandsProcessed !== undefined && (
                        <div className="p-2 rounded bg-bro-obsidian/70 border border-white/10 col-span-2">
                          <div className="text-slate-500 uppercase">Commands Routed</div>
                          <div className="text-bro-cyan font-bold tabular-nums mt-0.5">
                            {ag.commandsProcessed.toLocaleString()} deterministic intents
                          </div>
                        </div>
                      )}
                      {ag.hitlThreshold !== undefined && (
                        <div className="p-2 rounded bg-bro-obsidian/70 border border-white/10 col-span-2">
                          <div className="text-slate-500 uppercase">HITL Confidence Lock</div>
                          <div className="text-bro-cyan font-bold tabular-nums mt-0.5">
                            &gt;= {Math.round(ag.hitlThreshold * 100)}% Auto / &lt;{Math.round(ag.hitlThreshold * 100)}% Human Gate
                          </div>
                        </div>
                      )}
                      {ag.hitlVarianceGate && (
                        <div className="p-2 rounded bg-bro-obsidian/70 border border-white/10 col-span-2">
                          <div className="text-slate-500 uppercase">Rate-Con Variance Lock</div>
                          <div className="text-bro-gold font-bold tabular-nums mt-0.5">
                            Exact Match ({ag.hitlVarianceGate} tolerance)
                          </div>
                        </div>
                      )}
                    </div>

                    {findings.length > 0 && (
                      <div className="p-2.5 rounded bg-rose-950/40 border border-bro-crimson/35 space-y-1 max-h-28 overflow-y-auto">
                        {findings.slice(0, 4).map((f, idx) => (
                          <div key={idx} className="flex items-start gap-1.5 font-mono text-[10px] text-rose-100">
                            <AlertTriangle className="w-3 h-3 text-bro-crimson shrink-0 mt-0.5" />
                            <span>
                              <strong className="text-white">{f.entityId}:</strong> {f.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Governance Controls */}
                  <div className="pt-3 border-t border-white/10 flex items-center gap-2">
                    {isControllable ? (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleAgentAction(ag.agent, 'run')}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-[11px] font-bold uppercase hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                        >
                          <Activity className="w-3.5 h-3.5" />
                          {isBusy ? 'Running...' : 'Run Audit Now'}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleAgentAction(ag.agent, 'toggle', !isEnabled)}
                          className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border font-mono text-[11px] font-bold uppercase cursor-pointer disabled:opacity-50 ${
                            isEnabled
                              ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold hover:bg-bro-gold/25'
                              : 'bg-emerald-950/70 border-emerald-500/45 text-emerald-300 hover:bg-emerald-900'
                          }`}
                        >
                          {isEnabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                          {isEnabled ? 'Pause' : 'Resume'}
                        </button>
                      </>
                    ) : (
                      <div className="w-full flex items-center justify-between font-mono text-[10px] text-slate-400">
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <ShieldCheck className="w-3.5 h-3.5" /> Enforced HITL / Event-Driven
                        </span>
                        <span className="uppercase">Managed Runtime</span>
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
      <section aria-label="RBAC User Role Editor" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-bro-gold" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Zero-Trust RBAC User Role Editor ({users.length})
            </h2>
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            Dual-Portal isolation enforced via Better Auth &amp; edge middleware
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">User &amp; Email</th>
                <th className="px-4 py-2.5">Organization</th>
                <th className="px-4 py-2.5">Assigned RBAC Role</th>
                <th className="px-4 py-2.5">Account State</th>
                <th className="px-4 py-2.5 text-right">Apply Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center font-mono text-slate-500">
                    {loading ? 'Loading RBAC directory...' : 'No users found.'}
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const draft = userDrafts[u.id] || { role: u.role, active: u.active };
                  const dirty = draft.role !== u.role || draft.active !== u.active;
                  const isBusy = busyUserId === u.id;
                  return (
                    <tr key={u.id} className="hover:bg-white/5">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{u.name}</div>
                        <div className="font-mono text-[10px] text-slate-400">{u.email}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                        {u.organizationId || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <select
                          aria-label={`RBAC role for ${u.email}`}
                          value={draft.role}
                          onChange={(e) =>
                            setUserDrafts((prev) => ({
                              ...prev,
                              [u.id]: { ...draft, role: e.target.value as UserRole },
                            }))
                          }
                          className="rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan px-2.5 py-1.5 font-mono text-xs text-white"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setUserDrafts((prev) => ({
                              ...prev,
                              [u.id]: { ...draft, active: !draft.active },
                            }))
                          }
                          className={`px-2.5 py-1 rounded border font-mono text-[10px] uppercase font-bold cursor-pointer ${
                            draft.active
                              ? 'bg-emerald-950/70 border-emerald-500/45 text-emerald-300'
                              : 'bg-rose-950/70 border-bro-crimson/50 text-rose-200'
                          }`}
                        >
                          {draft.active ? 'ACTIVE' : 'SUSPENDED'}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={!dirty || isBusy}
                          onClick={() => void handleSaveUserRole(u)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-[11px] font-bold uppercase cursor-pointer transition-colors ${
                            dirty
                              ? 'bg-bro-cyan text-bro-obsidian hover:bg-cyan-300'
                              : 'bg-bro-steel border border-white/10 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          <Save className="w-3.5 h-3.5" />
                          {isBusy ? 'Saving...' : 'Save Role'}
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
      <section aria-label="Immutable Security Audit Trail" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-bro-cyan" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Immutable Security &amp; Operations Audit Trail ({filteredLogs.length})
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Search action, entity, details..."
                className="pl-8 pr-3 py-1.5 rounded bg-bro-obsidian border border-white/15 focus:border-bro-cyan font-mono text-[11px] text-white placeholder-slate-500 outline-none"
              />
            </div>

            <div className="inline-flex rounded border border-white/15 bg-bro-obsidian p-0.5">
              {(['all', 'user', 'agent', 'workflow', 'webhook', 'system'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setActorFilter(kind)}
                  className={`px-2 py-1 rounded font-mono text-[10px] uppercase cursor-pointer ${
                    actorFilter === kind
                      ? 'bg-bro-cyan/20 text-bro-cyan font-bold'
                      : 'text-slate-400 hover:text-white'
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
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">Timestamp (UTC)</th>
                <th className="px-4 py-2.5">Actor</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Entity</th>
                <th className="px-4 py-2.5">Payload Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs font-mono">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    <Terminal className="w-5 h-5 mx-auto mb-1 text-slate-600" />
                    No audit records match the current filter.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 text-slate-400 tabular-nums whitespace-nowrap text-[11px]">
                      {formatUtc(log.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[10px] uppercase font-bold ${
                          log.actorType === 'agent'
                            ? 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold'
                            : log.actorType === 'webhook'
                              ? 'bg-bro-cyan/15 border-bro-cyan/40 text-bro-cyan'
                              : log.actorType === 'user'
                                ? 'bg-indigo-950/70 border-indigo-500/40 text-indigo-300'
                                : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}
                      >
                        {log.actorType}
                      </span>
                      {log.actorUserId && (
                        <div className="text-[10px] text-slate-500 mt-0.5">{log.actorUserId}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-bold text-white whitespace-nowrap">{log.action}</td>
                    <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                      <span className="text-slate-500">{log.entityType}/</span>
                      {log.entityId}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-slate-400 max-w-md truncate" title={log.detailJson || ''}>
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
