import { useState, useEffect, useCallback, type SyntheticEvent } from 'react';
import {
  Building2,
  CheckCircle2,
  Copy,
  KeyRound,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Truck,
  UserCheck,
  X,
} from 'lucide-react';
import type { EquipmentType } from '@bro/contracts';

interface DriverRow {
  id: string;
  userId: string | null;
  organizationId: string | null;
  fullName: string;
  phone: string;
  email: string;
  equipmentDivision: EquipmentType;
  preferredLanes: string;
  licenseNumber: string | null;
  licenseClass: string | null;
  fastCardNumber: string | null;
  payModel: string;
  payRateValue: number;
  status: 'applicant' | 'active' | 'on_leave' | 'inactive';
  createdAt: number;
}

interface OrganizationRow {
  id: string;
  name: string;
  type: 'shipper' | 'carrier' | 'factor' | 'internal';
  usdot: string | null;
  mcNumber: string | null;
  phone: string | null;
  billingEmail: string | null;
  fmcsaSnapshotJson: string | null;
  status: 'pending' | 'active' | 'suspended' | 'rejected';
  createdAt: number;
}

interface FmcsaLookupResult {
  dotNumber?: string;
  legalName?: string;
  allowedToOperate?: boolean;
  bipdInsuranceOnFileDollars?: number;
  totalPowerUnits?: number;
  safetyRating?: string;
  fraudAssessment?: {
    riskLevel: 'LOW' | 'ELEVATED' | 'CRITICAL';
    findings: Array<{ code: string; detail: string }>;
  };
  error?: string;
}

export default function OnboardingVettingDesk() {
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [dotQuery, setDotQuery] = useState('3849201');
  const [dotResult, setDotResult] = useState<FmcsaLookupResult | null>(null);
  const [dotLoading, setDotLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issuedInvite, setIssuedInvite] = useState<{
    driverName: string;
    email: string;
    activateUrl: string;
  } | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const fetchApplicants = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ops/carriers');
      if (res.ok) {
        const data = (await res.json()) as {
          drivers?: DriverRow[];
          organizations?: OrganizationRow[];
        };
        setDrivers(Array.isArray(data.drivers) ? data.drivers : []);
        setOrganizations(Array.isArray(data.organizations) ? data.organizations : []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchApplicants();
    const onExecuted = () => void fetchApplicants();
    window.addEventListener('bro:agent-action-executed', onExecuted);
    return () => window.removeEventListener('bro:agent-action-executed', onExecuted);
  }, [fetchApplicants]);

  const handleVerifyDot = async (e: SyntheticEvent) => {
    e.preventDefault();
    const clean = dotQuery.trim();
    if (!clean) return;
    setDotLoading(true);
    setDotResult(null);
    try {
      const res = await fetch(`/api/carriers/verify-dot/${encodeURIComponent(clean)}`);
      const data = (await res.json()) as FmcsaLookupResult;
      setDotResult(data);
    } catch {
      setDotResult({ error: 'Unable to reach FMCSA QCMobile gateway.' });
    } finally {
      setDotLoading(false);
    }
  };

  const handleApproveDriver = async (drv: DriverRow) => {
    setBusyId(drv.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/carriers/${drv.id}/approve`, {
        method: 'PATCH',
      });
      const data = (await res.json()) as {
        error?: string;
        activateUrl?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to approve applicant.');
      }

      if (data.activateUrl) {
        setIssuedInvite({
          driverName: drv.fullName,
          email: drv.email,
          activateUrl: data.activateUrl,
        });
      }
      setBanner({
        kind: 'success',
        text: `Approved ${drv.fullName} to active fleet roster and generated 48-hour Driver Portal activation link.`,
      });
      await fetchApplicants();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Approval failed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleApproveOrg = async (org: OrganizationRow, nextStatus: 'active' | 'rejected') => {
    setBusyId(org.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/carriers/organizations/${org.id}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update carrier status.');
      }
      setBanner({
        kind: 'success',
        text: `Carrier organization ${org.name} marked ${nextStatus.toUpperCase()}.`,
      });
      await fetchApplicants();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Carrier update failed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const copyInviteUrl = async () => {
    if (!issuedInvite) return;
    try {
      await navigator.clipboard.writeText(issuedInvite.activateUrl);
      setBanner({
        kind: 'success',
        text: `Copied Driver Portal activation link for ${issuedInvite.driverName}.`,
      });
    } catch {
      // ignore
    }
  };

  const openRecruiterCopilot = () => {
    window.dispatchEvent(
      new CustomEvent('bro:open-copilot', {
        detail: {
          agentId: 'RecruiterVettingAgent',
          prompt: 'Summarize pending driver and carrier applications awaiting approval.',
        },
      }),
    );
  };

  const applicantDrivers = drivers.filter((d) => d.status === 'applicant');
  const activeDrivers = drivers.filter((d) => d.status === 'active');
  const carrierOrgs = organizations.filter((o) => o.type === 'carrier');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-bro-cyan">
            <UserCheck className="w-4 h-4" />
            <span>Fleet Recruiting &amp; Carrier Compliance · FMCSA QCMobile &amp; Portal Provisioning</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-white">
            Driver Recruiting &amp; Carrier Onboarding Vetting Desk
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
            Review incoming <code className="font-mono text-bro-cyan">/apply</code> driver applications, verify 49 CFR § 387.9 BIPD insurance and double-brokering flags, and issue 1-click Driver Portal activation links.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openRecruiterCopilot}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>Run Recruiter Vetting Agent</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchApplicants()}
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

      {/* Newly Issued Driver Portal Activation Link Callout */}
      {issuedInvite && (
        <div className="p-4 sm:p-5 rounded-2xl border border-bro-gold/40 bg-bro-gold/10 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-mono uppercase text-bro-gold font-semibold">
              <KeyRound className="w-4 h-4" />
              <span>Driver Portal Activation Link Generated (48-Hour Expiry)</span>
            </div>
            <button
              type="button"
              onClick={() => setIssuedInvite(null)}
              className="text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-200">
            Share this activation link with <strong>{issuedInvite.driverName}</strong> ({issuedInvite.email}) so they can set their permanent password and sign in to <code className="font-mono text-bro-cyan">/portal/driver</code>:
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              type="text"
              readOnly
              value={issuedInvite.activateUrl}
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-950 border border-white/15 font-mono text-xs text-bro-cyan"
            />
            <button
              type="button"
              onClick={() => void copyInviteUrl()}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-bro-gold hover:bg-amber-400 text-black font-semibold text-xs cursor-pointer transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy Link</span>
            </button>
          </div>
        </div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Pending Driver Applicants</div>
          <div className="font-display text-2xl font-bold text-bro-gold">{applicantDrivers.length}</div>
          <div className="text-[11px] text-slate-400">Submitted via /apply</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Active Approved Drivers</div>
          <div className="font-display text-2xl font-bold text-emerald-400">{activeDrivers.length}</div>
          <div className="text-[11px] text-slate-400">Cleared for cross-border dispatch</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Partner Carrier Authorities</div>
          <div className="font-display text-2xl font-bold text-white">{carrierOrgs.length}</div>
          <div className="text-[11px] text-slate-400">FMCSA USDOT vetted</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Minimum BIPD Coverage Gate</div>
          <div className="font-display text-2xl font-bold text-bro-cyan">$750,000</div>
          <div className="text-[11px] text-slate-400">49 CFR § 387.9 Federal Minimum</div>
        </div>
      </div>

      {/* Live FMCSA USDOT Verification Sandbox + Driver Applicants */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-bro-cyan" />
            <span>Live FMCSA QCMobile &amp; Fraud Vetting</span>
          </h2>

          <form onSubmit={handleVerifyDot} className="flex items-center gap-2">
            <input
              type="text"
              value={dotQuery}
              onChange={(e) => setDotQuery(e.target.value)}
              placeholder="Enter USDOT # (e.g. 3849201 or 123456)"
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-950 border border-white/15 font-mono text-xs text-white"
            />
            <button
              type="submit"
              disabled={dotLoading}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black font-semibold text-xs cursor-pointer transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
              <span>{dotLoading ? 'Checking...' : 'Audit DOT'}</span>
            </button>
          </form>

          {dotResult && (
            <div className="p-4 rounded-xl bg-slate-950 border border-white/10 space-y-2.5 text-xs">
              {dotResult.error ? (
                <div className="text-rose-300">{dotResult.error}</div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white">{dotResult.legalName ?? `USDOT #${dotResult.dotNumber}`}</span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full font-mono text-[11px] ${
                        dotResult.fraudAssessment?.riskLevel === 'LOW'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-950 text-rose-200 border border-rose-500/40'
                      }`}
                    >
                      Risk: {dotResult.fraudAssessment?.riskLevel ?? 'VERIFIED'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300">
                    <div>Authority: {dotResult.allowedToOperate ? 'ACTIVE' : 'INACTIVE'}</div>
                    <div>Power Units: {dotResult.totalPowerUnits ?? 0}</div>
                    <div>
                      BIPD On File: ${(dotResult.bipdInsuranceOnFileDollars ?? 0).toLocaleString()}
                    </div>
                    <div>Rating: {dotResult.safetyRating ?? 'SATISFACTORY'}</div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Driver Applicants & Roster Table */}
        <div className="lg:col-span-7 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <Truck className="w-4 h-4 text-bro-gold" />
              <span>Driver Applications &amp; Active Fleet Roster ({drivers.length})</span>
            </h2>
          </div>

          <div className="space-y-3">
            {drivers.map((drv) => {
              const isApplicant = drv.status === 'applicant';
              const isBusy = busyId === drv.id;
              return (
                <div
                  key={drv.id}
                  className="p-4 rounded-2xl border border-white/10 bg-slate-950/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-sm font-bold text-white">{drv.fullName}</span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-mono uppercase border ${
                          isApplicant
                            ? 'bg-bro-gold/15 text-bro-gold border-bro-gold/40'
                            : 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40'
                        }`}
                      >
                        {drv.status}
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-white/[0.06] font-mono text-[11px] text-slate-200">
                        {drv.equipmentDivision.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-xs text-slate-300">
                      {drv.email} · {drv.phone}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Preferred Lanes: {drv.preferredLanes} · CDL: {drv.licenseNumber ?? 'Pending Scan'} · FAST:{' '}
                      {drv.fastCardNumber ?? 'Pending'}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleApproveDriver(drv)}
                      className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs cursor-pointer transition-colors"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>
                        {isBusy
                          ? 'Provisioning...'
                          : isApplicant
                            ? 'Approve & Issue Portal Link'
                            : 'Re-Issue Portal Invite'}
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Partner Carrier Organizations Table */}
      {carrierOrgs.length > 0 && (
        <div className="surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
            <Building2 className="w-4 h-4 text-bro-cyan" />
            <span>Partner Carrier Organizations ({carrierOrgs.length})</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {carrierOrgs.map((org) => (
              <div
                key={org.id}
                className="p-4 rounded-2xl border border-white/10 bg-slate-950/80 flex items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="font-display text-sm font-bold text-white">{org.name}</div>
                  <div className="text-xs font-mono text-slate-300">
                    USDOT: {org.usdot ?? 'N/A'} · MC: {org.mcNumber ?? 'N/A'}
                  </div>
                  <div className="text-[11px] text-slate-400">Status: {org.status.toUpperCase()}</div>
                </div>
                {org.status === 'pending' && (
                  <button
                    type="button"
                    disabled={busyId === org.id}
                    onClick={() => void handleApproveOrg(org, 'active')}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl bg-bro-cyan text-black font-semibold text-xs cursor-pointer"
                  >
                    Approve Carrier
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
