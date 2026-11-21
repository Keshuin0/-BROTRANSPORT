import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  Copy,
  KeyRound,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldCheck,
  Terminal,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { ROLE_LABELS, UserRoleSchema, type UserRole } from '@bro/contracts';
import { BroWsClient } from '../../lib/wsClient';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

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
  title?: string | null;
  organizationId: string | null;
  mustChangePassword?: boolean;
  lastLoginAt?: number | null;
  emailVerified?: boolean;
  active: boolean;
  createdAt: number;
}

interface StaffInviteRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  title: string | null;
  organizationId: string | null;
  driverId: string | null;
  invitedByUserId: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

interface OrganizationOption {
  id: string;
  name: string;
  type: string;
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

interface UserDraft {
  role: UserRole;
  title: string;
  organizationId: string;
  active: boolean;
}

const ALL_ROLES: readonly UserRole[] = UserRoleSchema.options;
const ASSIGNABLE_ROLES: readonly UserRole[] = ALL_ROLES.filter((r) => r !== 'visitor');
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
  if (!ms) return 'Never';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/** Generates a 16-character CSPRNG temporary password using Web Crypto (zero Math.random). */
function generateCsprngTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const rand = new Uint32Array(16);
  crypto.getRandomValues(rand);
  let out = '';
  for (let i = 0; i < rand.length; i++) {
    out += alphabet[rand[i]! % alphabet.length];
  }
  return out;
}

export default function AgentControlCenter() {
  const [agents, setAgents] = useState<AgentStatusRow[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [invites, setInvites] = useState<StaffInviteRow[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [latestActivationUrl, setLatestActivationUrl] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Per-agent busy state
  const [busyAgent, setBusyAgent] = useState<string | null>(null);

  // Local edits for RBAC User Role editor
  const [userDrafts, setUserDrafts] = useState<Record<string, UserDraft>>({});
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Invite action busy state
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  // Modals: Invite Staff via Email Link & Create Staff w/ Temp Password
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    name: '',
    email: '',
    role: 'dispatcher' as UserRole,
    title: '',
    organizationId: 'org_bro_internal',
  });
  const [inviteCreatedLink, setInviteCreatedLink] = useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    email: '',
    role: 'dispatcher' as UserRole,
    title: '',
    organizationId: 'org_bro_internal',
    tempPassword: '',
  });
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const closeInviteModal = useCallback(() => {
    setInviteModalOpen(false);
    setInviteCreatedLink(null);
  }, []);

  const closeCreateModal = useCallback(() => {
    setCreateModalOpen(false);
  }, []);

  const inviteModalTrap = useModalFocusTrap({
    open: inviteModalOpen,
    onClose: closeInviteModal,
  });

  const createModalTrap = useModalFocusTrap({
    open: createModalOpen,
    onClose: closeCreateModal,
  });

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
        const uData = (await usersRes.json()) as {
          users: AdminUserRow[];
          invites?: StaffInviteRow[];
          organizations?: OrganizationOption[];
        };
        const list = uData.users || [];
        setUsers(list);
        setInvites(uData.invites || []);
        setOrganizations(uData.organizations || []);
        const drafts: Record<string, UserDraft> = {};
        for (const u of list) {
          drafts[u.id] = {
            role: u.role,
            title: u.title || '',
            organizationId: u.organizationId || '',
            active: u.active,
          };
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

  const handleCopyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setCopiedLink(false);
    }
  };

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
        body: JSON.stringify({
          role: draft.role,
          active: draft.active,
          title: draft.title.trim() || null,
          organizationId: draft.organizationId.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || `Role update failed (HTTP ${res.status}).` });
      } else {
        setBanner({
          kind: 'success',
          text: `Updated ${user.email} -> ${ROLE_LABELS[draft.role]} (${draft.active ? 'ACTIVE' : 'SUSPENDED'}).`,
        });
        await fetchAdminData();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error updating user RBAC role.' });
    } finally {
      setBusyUserId(null);
    }
  };

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch('/api/ops/admin/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: inviteForm.name.trim(),
          email: inviteForm.email.trim(),
          role: inviteForm.role,
          ...(inviteForm.title.trim().length >= 2 ? { title: inviteForm.title.trim() } : {}),
          ...(inviteForm.organizationId.trim() ? { organizationId: inviteForm.organizationId.trim() } : {}),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        activateUrl?: string;
        emailSent?: boolean;
      };
      if (!res.ok) throw new Error(data.error || 'Failed to issue staff invite.');

      const link = data.activateUrl || '';
      setInviteCreatedLink(link);
      setLatestActivationUrl(link);
      setBanner({
        kind: 'success',
        text: `Invitation generated for ${inviteForm.email} (${ROLE_LABELS[inviteForm.role]}).`,
      });
      await fetchAdminData();
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Unable to send invite.' });
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch('/api/ops/admin/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createForm.name.trim(),
          email: createForm.email.trim(),
          role: createForm.role,
          ...(createForm.title.trim().length >= 2 ? { title: createForm.title.trim() } : {}),
          ...(createForm.organizationId.trim() ? { organizationId: createForm.organizationId.trim() } : {}),
          tempPassword: createForm.tempPassword,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to create staff account.');

      setBanner({
        kind: 'success',
        text: `Provisioned ${createForm.email} (${ROLE_LABELS[createForm.role]}) with mandatory first-login password rotation.`,
      });
      setCreateModalOpen(false);
      setCreateForm({
        name: '',
        email: '',
        role: 'dispatcher',
        title: '',
        organizationId: 'org_bro_internal',
        tempPassword: generateCsprngTempPassword(),
      });
      await fetchAdminData();
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Unable to create user.' });
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleInviteAction = async (inviteId: string, action: 'resend' | 'revoke') => {
    setBusyInviteId(inviteId);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/admin/invites/${encodeURIComponent(inviteId)}/${action}`, {
        method: 'POST',
      });
      const data = (await res.json()) as { error?: string; activateUrl?: string };
      if (!res.ok) throw new Error(data.error || `Failed to ${action} invite.`);

      if (action === 'resend' && data.activateUrl) {
        setLatestActivationUrl(data.activateUrl);
        setBanner({
          kind: 'success',
          text: 'Invite token rotated (48h expiry) and fresh activation link generated below.',
        });
      } else {
        setBanner({
          kind: 'success',
          text: 'Staff invite revoked and logged to immutable audit trail.',
        });
      }
      await fetchAdminData();
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Invite action failed.' });
    } finally {
      setBusyInviteId(null);
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
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-gold">
            Super Admin Governance · 15-Role RBAC · Staff Provisioning · Autonomous Agents
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Autonomous Agent &amp; Security Control Center
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              setInviteCreatedLink(null);
              setInviteForm({
                name: '',
                email: '',
                role: 'dispatcher',
                title: '',
                organizationId: 'org_bro_internal',
              });
              setInviteModalOpen(true);
            }}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian hover:bg-cyan-300 text-xs font-bold cursor-pointer transition-colors"
          >
            <Mail className="w-4 h-4" aria-hidden="true" />
            <span>+ Invite Staff via Email Link</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateForm({
                name: '',
                email: '',
                role: 'dispatcher',
                title: '',
                organizationId: 'org_bro_internal',
                tempPassword: generateCsprngTempPassword(),
              });
              setCreateModalOpen(true);
            }}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-gold/15 border border-bro-gold/45 hover:bg-bro-gold/25 text-xs font-semibold text-bro-gold cursor-pointer transition-colors"
          >
            <UserPlus className="w-4 h-4" aria-hidden="true" />
            <span>+ Create Staff w/ Temp Password</span>
          </button>
          <button
            type="button"
            disabled={busyAgent === '__seed__'}
            onClick={() => void handleBootstrapSeed()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-gold/50 text-xs font-semibold text-slate-200 cursor-pointer disabled:opacity-50 transition-colors"
          >
            <ShieldCheck className="w-4 h-4 text-bro-gold" aria-hidden="true" />
            <span>{busyAgent === '__seed__' ? 'Seeding Fleet...' : 'Initialize Fleet Seed'}</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchAdminData()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-xs font-semibold text-white cursor-pointer transition-colors"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            <span>Sync State</span>
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

      {/* Copyable Activation Link Banner */}
      {latestActivationUrl && (
        <div className="p-4 rounded-2xl bg-[#0b1120] border border-bro-cyan/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="space-y-1 min-w-0">
            <div className="font-semibold text-bro-cyan">
              Single-Use Onboarding Activation Link (48-Hour Expiry)
            </div>
            <div className="font-mono text-slate-200 truncate">{latestActivationUrl}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleCopyLink(latestActivationUrl)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-xl bg-bro-cyan text-bro-obsidian font-bold cursor-pointer hover:bg-cyan-300 transition-colors"
            >
              {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedLink ? 'Copied' : 'Copy Link'}</span>
            </button>
            <button
              type="button"
              onClick={() => setLatestActivationUrl(null)}
              aria-label="Close activation link banner"
              className="p-2 min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-white/15 text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
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

      {/* Pending Staff & Driver Invites */}
      <section aria-label="Pending Staff and Driver Invites" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Pending Staff &amp; Driver Invites ({invites.length})
            </h2>
          </div>
          <span className="text-xs text-slate-400">
            SHA-256 hashed activation tokens · 48-hour expiry window
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Recipient &amp; Email</th>
                <th className="px-4 py-3">Role &amp; Title</th>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3">Expires (UTC)</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {invites.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-300">
                    No staff or driver onboarding invitations issued yet.
                  </td>
                </tr>
              ) : (
                invites.map((inv) => {
                  const isAccepted = Boolean(inv.acceptedAt);
                  const isRevoked = Boolean(inv.revokedAt);
                  const isExpired = !isAccepted && !isRevoked && inv.expiresAt <= Date.now();
                  const isBusy = busyInviteId === inv.id;

                  return (
                    <tr key={inv.id} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-white">{inv.name}</div>
                        <div className="font-mono text-xs text-slate-400">{inv.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-bro-cyan">
                          {ROLE_LABELS[inv.role] ?? inv.role}
                        </div>
                        {inv.title && <div className="text-slate-400">{inv.title}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300 whitespace-nowrap">
                        {inv.organizationId || '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300 whitespace-nowrap">
                        {formatUtc(inv.expiresAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-1 rounded-full border text-xs font-semibold uppercase ${
                            isAccepted
                              ? 'bg-emerald-950/70 border-emerald-400/45 text-emerald-200'
                              : isRevoked
                                ? 'bg-rose-950/70 border-rose-400/50 text-rose-200'
                                : isExpired
                                  ? 'bg-amber-950/70 border-amber-400/50 text-amber-200'
                                  : 'bg-bro-cyan/15 border-bro-cyan/40 text-bro-cyan'
                          }`}
                        >
                          {isAccepted ? 'Accepted' : isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Pending'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          {!isAccepted && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleInviteAction(inv.id, 'resend')}
                              className="px-3 py-1.5 min-h-[38px] rounded-xl bg-bro-cyan/15 border border-bro-cyan/40 hover:bg-bro-cyan/25 text-bro-cyan font-semibold cursor-pointer disabled:opacity-50"
                            >
                              Resend
                            </button>
                          )}
                          {!isAccepted && !isRevoked && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleInviteAction(inv.id, 'revoke')}
                              className="px-3 py-1.5 min-h-[38px] rounded-xl bg-rose-950/60 border border-rose-400/45 hover:bg-rose-900/70 text-rose-200 font-semibold cursor-pointer disabled:opacity-50"
                            >
                              Revoke
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

      {/* RBAC User Role Editor */}
      <section aria-label="RBAC User Role Editor" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Zero-Trust 15-Role RBAC Directory &amp; Editor ({users.length})
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
                <th className="px-4 py-3">Specialist Title</th>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3">Assigned RBAC Role</th>
                <th className="px-4 py-3">Account State</th>
                <th className="px-4 py-3 text-right">Apply Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-300">
                    {loading ? 'Loading RBAC directory...' : 'No users found.'}
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const draft = userDrafts[u.id] || {
                    role: u.role,
                    title: u.title || '',
                    organizationId: u.organizationId || '',
                    active: u.active,
                  };
                  const dirty =
                    draft.role !== u.role ||
                    draft.active !== u.active ||
                    draft.title !== (u.title || '') ||
                    draft.organizationId !== (u.organizationId || '');
                  const isBusy = busyUserId === u.id;
                  return (
                    <tr key={u.id} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3.5">
                        <div className="text-sm font-medium text-white flex items-center gap-2">
                          <span>{u.name}</span>
                          {u.mustChangePassword && (
                            <span className="px-2 py-0.5 rounded-full bg-bro-gold/15 border border-bro-gold/40 text-[10px] font-semibold text-bro-gold uppercase">
                              Temp PW
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-xs text-slate-400">{u.email}</div>
                      </td>
                      <td className="px-4 py-3.5">
                        <input
                          type="text"
                          aria-label={`Specialist title for ${u.email}`}
                          value={draft.title}
                          onChange={(e) =>
                            setUserDrafts((prev) => ({
                              ...prev,
                              [u.id]: { ...draft, title: e.target.value },
                            }))
                          }
                          placeholder="Specialist title..."
                          className="w-44 rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white outline-none"
                        />
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <input
                          type="text"
                          aria-label={`Organization ID for ${u.email}`}
                          value={draft.organizationId}
                          onChange={(e) =>
                            setUserDrafts((prev) => ({
                              ...prev,
                              [u.id]: { ...draft, organizationId: e.target.value },
                            }))
                          }
                          placeholder="org_bro_internal"
                          className="w-40 rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white outline-none"
                        />
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
                          className="rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white outline-none"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]} ({r})
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
                          className={`px-3 py-1.5 min-h-[40px] rounded-full border text-xs uppercase font-semibold cursor-pointer transition-colors ${
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
                          className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl text-xs font-bold uppercase tracking-wider transition-colors ${
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

      {/* Modal 1: Invite Staff via Email Link */}
      {inviteModalTrap.mounted && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm transition-opacity duration-200 ${
            inviteModalTrap.visible ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeInviteModal();
          }}
        >
          <div
            ref={inviteModalTrap.containerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-modal-title"
            className="w-full max-w-lg surface-ceramic rounded-3xl p-6 border border-white/15 space-y-5"
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div>
                <h3 id="invite-modal-title" className="text-lg font-display font-bold text-white">
                  Invite Staff or Portal User via Email Link
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Generates a 48-hour SHA-256 activation link and dispatches an onboarding email.
                </p>
              </div>
              <button
                type="button"
                onClick={closeInviteModal}
                aria-label="Close invite modal"
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleInviteSubmit} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="inv-name" className="block font-medium text-slate-300">
                    Full Name
                  </label>
                  <input
                    id="inv-name"
                    type="text"
                    required
                    value={inviteForm.name}
                    onChange={(e) => setInviteForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Genevieve Poirier"
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="inv-email" className="block font-medium text-slate-300">
                    Corporate Email
                  </label>
                  <input
                    id="inv-email"
                    type="email"
                    required
                    value={inviteForm.email}
                    onChange={(e) => setInviteForm((p) => ({ ...p, email: e.target.value }))}
                    placeholder="name@brotransport.com"
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="inv-role" className="block font-medium text-slate-300">
                    Assigned RBAC Role
                  </label>
                  <select
                    id="inv-role"
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm((p) => ({ ...p, role: e.target.value as UserRole }))}
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]} ({r})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="inv-title" className="block font-medium text-slate-300">
                    Specialist Title
                  </label>
                  <input
                    id="inv-title"
                    type="text"
                    value={inviteForm.title}
                    onChange={(e) => setInviteForm((p) => ({ ...p, title: e.target.value }))}
                    placeholder="Lead Customs Broker"
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="inv-org" className="block font-medium text-slate-300">
                  Organization ID
                </label>
                <input
                  id="inv-org"
                  type="text"
                  list="invite-org-options"
                  value={inviteForm.organizationId}
                  onChange={(e) => setInviteForm((p) => ({ ...p, organizationId: e.target.value }))}
                  placeholder="org_bro_internal"
                  className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 font-mono text-white outline-none focus:border-bro-cyan"
                />
                <datalist id="invite-org-options">
                  <option value="org_bro_internal">#BRO Transport Corp. (Internal)</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.type})
                    </option>
                  ))}
                </datalist>
              </div>

              {inviteCreatedLink && (
                <div className="p-3.5 rounded-2xl bg-[#060912] border border-bro-cyan/40 space-y-2">
                  <div className="font-semibold text-bro-cyan">
                    Activation Link Ready (Copy &amp; Share Directly)
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={inviteCreatedLink}
                      className="flex-1 min-h-[38px] rounded-xl bg-[#0b1120] border border-white/15 px-3 py-1.5 font-mono text-xs text-white"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCopyLink(inviteCreatedLink)}
                      className="px-3 py-2 min-h-[38px] rounded-xl bg-bro-cyan text-bro-obsidian font-bold cursor-pointer"
                    >
                      {copiedLink ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeInviteModal}
                  className="px-4 py-2 min-h-[42px] rounded-xl border border-white/15 text-slate-300 hover:text-white cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={inviteSubmitting}
                  className="px-5 py-2 min-h-[42px] rounded-xl bg-bro-cyan text-bro-obsidian font-bold hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                >
                  {inviteSubmitting ? 'Generating Link...' : 'Generate Invite Link'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Create Staff w/ Temp Password */}
      {createModalTrap.mounted && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm transition-opacity duration-200 ${
            createModalTrap.visible ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeCreateModal();
          }}
        >
          <div
            ref={createModalTrap.containerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-modal-title"
            className="w-full max-w-lg surface-ceramic rounded-3xl p-6 border border-white/15 space-y-5"
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div>
                <h3 id="create-modal-title" className="text-lg font-display font-bold text-white">
                  Provision Staff with Temporary Password
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Creates an active account with mandatory password rotation on first login.
                </p>
              </div>
              <button
                type="button"
                onClick={closeCreateModal}
                aria-label="Close create staff modal"
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateUserSubmit} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="crt-name" className="block font-medium text-slate-300">
                    Full Name
                  </label>
                  <input
                    id="crt-name"
                    type="text"
                    required
                    value={createForm.name}
                    onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Marcus Belliveau"
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="crt-email" className="block font-medium text-slate-300">
                    Corporate Email
                  </label>
                  <input
                    id="crt-email"
                    type="email"
                    required
                    value={createForm.email}
                    onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))}
                    placeholder="name@brotransport.com"
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="crt-role" className="block font-medium text-slate-300">
                    Assigned RBAC Role
                  </label>
                  <select
                    id="crt-role"
                    value={createForm.role}
                    onChange={(e) => setCreateForm((p) => ({ ...p, role: e.target.value as UserRole }))}
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]} ({r})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="crt-title" className="block font-medium text-slate-300">
                    Specialist Title
                  </label>
                  <input
                    id="crt-title"
                    type="text"
                    value={createForm.title}
                    onChange={(e) => setCreateForm((p) => ({ ...p, title: e.target.value }))}
                    placeholder="Corridor Load Planner"
                    className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 text-white outline-none focus:border-bro-cyan"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="crt-org" className="block font-medium text-slate-300">
                  Organization ID
                </label>
                <input
                  id="crt-org"
                  type="text"
                  value={createForm.organizationId}
                  onChange={(e) => setCreateForm((p) => ({ ...p, organizationId: e.target.value }))}
                  placeholder="org_bro_internal"
                  className="w-full min-h-[42px] rounded-xl bg-[#060912] border border-white/15 px-3 py-2 font-mono text-white outline-none focus:border-bro-cyan"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="crt-pass" className="block font-medium text-slate-300">
                    Temporary Password (min 10 chars)
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setCreateForm((p) => ({ ...p, tempPassword: generateCsprngTempPassword() }))
                    }
                    className="inline-flex items-center gap-1 text-bro-gold hover:text-amber-300 font-semibold cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Generate CSPRNG Password</span>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="crt-pass"
                    type="text"
                    required
                    minLength={10}
                    value={createForm.tempPassword}
                    onChange={(e) => setCreateForm((p) => ({ ...p, tempPassword: e.target.value }))}
                    className="flex-1 min-h-[42px] rounded-xl bg-[#060912] border border-bro-gold/40 px-3 py-2 font-mono text-white outline-none focus:border-bro-gold"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyLink(createForm.tempPassword)}
                    className="px-3 py-2 min-h-[42px] rounded-xl bg-white/10 hover:bg-white/20 text-white font-semibold cursor-pointer"
                  >
                    {copiedLink ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeCreateModal}
                  className="px-4 py-2 min-h-[42px] rounded-xl border border-white/15 text-slate-300 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createSubmitting}
                  className="px-5 py-2 min-h-[42px] rounded-xl bg-bro-gold text-black font-bold hover:bg-amber-300 cursor-pointer disabled:opacity-50"
                >
                  {createSubmitting ? 'Provisioning...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
