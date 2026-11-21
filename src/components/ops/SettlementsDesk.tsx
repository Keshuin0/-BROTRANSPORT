import { useState, useEffect, useCallback, type SyntheticEvent } from 'react';
import {
  CheckCircle2,
  DollarSign,
  Download,
  FileText,
  Lock,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import type { DriverPayModel, EquipmentType, LoadStatus } from '@bro/contracts';

interface DriverRow {
  id: string;
  fullName: string;
  email: string;
  equipmentDivision: EquipmentType;
  payModel: DriverPayModel;
  payRateValue: number;
  status: string;
}

interface LoadRow {
  id: string;
  loadNumber: string;
  assignedDriverId: string | null;
  equipmentType: EquipmentType;
  status: LoadStatus;
  commodity: string;
  loadedMiles: number;
  rateCustomerCents: number;
  detentionMinutes: number;
  currency: 'CAD' | 'USD';
  settlementBatchId: string | null;
}

interface SettlementRow {
  id: string;
  settlementNumber: string;
  driverId: string;
  periodStart: number;
  periodEnd: number;
  grossPayCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  netPayCents: number;
  currency: 'CAD' | 'USD';
  status: 'draft' | 'finalized' | 'paid';
  pdfR2Key: string | null;
  createdAt: number;
}

interface SettlementBatchRow {
  id: string;
  driverId: string;
  periodStart: number;
  periodEnd: number;
  grossPayCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  netPayCents: number;
  loadCount: number;
  status: string;
  createdAt: number;
}

function formatCents(cents: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  const val = (cents / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${val} ${currency}`;
}

export default function SettlementsDesk() {
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [settlements, setSettlements] = useState<SettlementRow[]>([]);
  const [batches, setBatches] = useState<SettlementBatchRow[]>([]);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [fuelDeductionDollars, setFuelDeductionDollars] = useState('0');
  const [insuranceDeductionDollars, setInsuranceDeductionDollars] = useState('0');
  const [reimbursementsDollars, setReimbursementsDollars] = useState('0');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ops/settlements');
      if (res.ok) {
        const data = (await res.json()) as {
          settlements?: SettlementRow[];
          drivers?: DriverRow[];
          batches?: SettlementBatchRow[];
          loads?: LoadRow[];
        };
        const drvList = Array.isArray(data.drivers) ? data.drivers : [];
        setDrivers(drvList);
        setSettlements(Array.isArray(data.settlements) ? data.settlements : []);
        setBatches(Array.isArray(data.batches) ? data.batches : []);
        setLoads(Array.isArray(data.loads) ? data.loads : []);
        if (!selectedDriverId && drvList[0]) {
          setSelectedDriverId(drvList[0].id);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [selectedDriverId]);

  useEffect(() => {
    void fetchData();
    const onExecuted = () => void fetchData();
    window.addEventListener('bro:agent-action-executed', onExecuted);
    return () => window.removeEventListener('bro:agent-action-executed', onExecuted);
  }, [fetchData]);

  const activeDriver = drivers.find((d) => d.id === selectedDriverId) ?? drivers[0];
  const driverLoads = loads.filter((l) => l.assignedDriverId === activeDriver?.id);
  const unsettledDriverLoads = driverLoads.filter((l) => !l.settlementBatchId);
  const lockedDriverLoads = driverLoads.filter((l) => Boolean(l.settlementBatchId));

  const totalUnsettledMiles = unsettledDriverLoads.reduce((s, l) => s + l.loadedMiles, 0);
  const totalUnsettledRevenueCents = unsettledDriverLoads.reduce((s, l) => s + l.rateCustomerCents, 0);
  const projectedBasePayCents = activeDriver
    ? activeDriver.payModel === 'cpm'
      ? Math.round(totalUnsettledMiles * activeDriver.payRateValue)
      : Math.round((totalUnsettledRevenueCents * activeDriver.payRateValue) / 10000)
    : 0;

  const handleGenerateSettlement = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!activeDriver) return;
    setSubmitting(true);
    setBanner(null);

    try {
      const fuelCents = Math.max(0, Math.round(Number(fuelDeductionDollars || 0) * 100));
      const insCents = Math.max(0, Math.round(Number(insuranceDeductionDollars || 0) * 100));
      const reimbCents = Math.max(0, Math.round(Number(reimbursementsDollars || 0) * 100));

      const res = await fetch('/api/ops/settlements/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId: activeDriver.id,
          fuelDeductionCents: fuelCents,
          insuranceDeductionCents: insCents,
          reimbursementsCents: reimbCents,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        settlementNumber?: string;
        settledLoadCount?: number;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate settlement batch.');
      }

      setBanner({
        kind: 'success',
        text: `Generated & locked settlement ${data.settlementNumber} across ${data.settledLoadCount ?? 0} load(s).`,
      });
      await fetchData();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to generate settlement.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openSettlementCopilot = () => {
    window.dispatchEvent(
      new CustomEvent('bro:open-copilot', {
        detail: {
          agentId: 'SettlementAuditAgent',
          prompt: 'Find delivered loads not yet batched into a driver settlement and audit projected batch totals.',
        },
      }),
    );
  };

  const totalNetPaidCents = settlements.reduce((s, r) => s + r.netPayCents, 0);
  const totalUnsettledAllDrivers = loads.filter((l) => l.assignedDriverId && !l.settlementBatchId).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-bro-gold">
            <ShieldCheck className="w-4 h-4" />
            <span>Financial Separation of Duties · Driver Payroll &amp; Settlement Audit</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-white">
            Driver Payroll &amp; Settlement Batch Ledger
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
            Integer-cent Company Driver (CPM) and Owner-Operator (% Gross) payroll generation with mandatory{' '}
            <code className="font-mono text-bro-cyan">settlementBatchId</code> double-payout locking and downloadable PDF statements.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openSettlementCopilot}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>Run Settlement Audit Agent</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchData()}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] hover:bg-white/10 text-xs font-medium text-slate-200 cursor-pointer transition-colors"
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
          <div className="text-xs text-slate-400">Active Payroll Drivers</div>
          <div className="font-display text-2xl font-bold text-white">{drivers.length}</div>
          <div className="text-[11px] text-slate-400">CPM &amp; Owner-Operator Contracts</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Un-Batched Assigned Loads</div>
          <div className="font-display text-2xl font-bold text-bro-gold">{totalUnsettledAllDrivers}</div>
          <div className="text-[11px] text-slate-400">Awaiting period settlement lock</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Locked Settlement Batches</div>
          <div className="font-display text-2xl font-bold text-bro-cyan">{batches.length}</div>
          <div className="text-[11px] text-slate-400">Double-payout lock enforced</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Cumulative Net Payroll Issued</div>
          <div className="font-display text-2xl font-bold text-emerald-400">
            {formatCents(totalNetPaidCents, 'CAD')}
          </div>
          <div className="text-[11px] text-slate-400">{settlements.length} PDF statement(s)</div>
        </div>
      </div>

      {/* Main Split: Settlement Batch Builder + Unsettled Loads Audit */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleGenerateSettlement}
          className="lg:col-span-5 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-bro-gold" />
              <span>Generate &amp; Lock Settlement Batch</span>
            </h2>
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-500/30 text-[11px] text-emerald-300 font-mono">
              Integer-Cent Engine
            </span>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="settle-driver" className="block text-xs font-medium text-slate-300">
              Select Fleet Driver
            </label>
            <select
              id="settle-driver"
              value={selectedDriverId}
              onChange={(e) => setSelectedDriverId(e.target.value)}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-950 border border-white/15 text-xs text-white"
            >
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName} ({d.payModel === 'cpm' ? `$${(d.payRateValue / 100).toFixed(2)}/mi CPM` : `${(d.payRateValue / 100).toFixed(1)}% Gross`})
                </option>
              ))}
            </select>
          </div>

          {activeDriver && (
            <div className="p-3.5 rounded-xl bg-slate-950/90 border border-white/10 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Un-batched Loads Eligible:</span>
                <span className="font-mono font-semibold text-white">{unsettledDriverLoads.length} load(s)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Eligible Loaded Miles:</span>
                <span className="font-mono text-slate-200">{totalUnsettledMiles.toLocaleString()} mi</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Projected Linehaul Pay:</span>
                <span className="font-mono font-bold text-bro-cyan">
                  {formatCents(projectedBasePayCents, 'CAD')}
                </span>
              </div>
              {lockedDriverLoads.length > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 pt-1 border-t border-white/10">
                  <Lock className="w-3.5 h-3.5 shrink-0" />
                  <span>{lockedDriverLoads.length} previously settled load(s) locked from duplicate payout.</span>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label htmlFor="settle-reimb" className="block text-[11px] text-slate-300">
                Reimbursements ($)
              </label>
              <input
                id="settle-reimb"
                type="number"
                min="0"
                step="0.01"
                value={reimbursementsDollars}
                onChange={(e) => setReimbursementsDollars(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-950 border border-white/15 text-xs text-white font-mono"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="settle-fuel" className="block text-[11px] text-slate-300">
                Fuel Deduction ($)
              </label>
              <input
                id="settle-fuel"
                type="number"
                min="0"
                step="0.01"
                value={fuelDeductionDollars}
                onChange={(e) => setFuelDeductionDollars(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-950 border border-white/15 text-xs text-white font-mono"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="settle-ins" className="block text-[11px] text-slate-300">
                Escrow / Ins. ($)
              </label>
              <input
                id="settle-ins"
                type="number"
                min="0"
                step="0.01"
                value={insuranceDeductionDollars}
                onChange={(e) => setInsuranceDeductionDollars(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-950 border border-white/15 text-xs text-white font-mono"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !activeDriver}
            className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-bro-gold hover:bg-amber-400 text-black font-semibold text-xs cursor-pointer transition-colors disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {submitting ? 'Auditing & Locking Settlement Batch...' : 'Approve & Issue Settlement Statement PDF'}
            </span>
          </button>
        </form>

        {/* Unsettled vs Locked Loads Table */}
        <div className="lg:col-span-7 surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <Users className="w-4 h-4 text-bro-cyan" />
              <span>Driver Load Eligibility &amp; Double-Payout Lock Ledger</span>
            </h2>
            <span className="text-xs text-slate-400">
              Showing loads for {activeDriver?.fullName ?? 'Selected Driver'}
            </span>
          </div>

          {driverLoads.length === 0 ? (
            <div className="p-6 rounded-xl border border-white/10 bg-slate-950/60 text-xs text-slate-400 text-center">
              No loads assigned to this driver yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-[11px] font-mono uppercase text-slate-400">
                    <th className="py-2.5 pr-3">Load #</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Loaded Miles</th>
                    <th className="py-2.5 px-3">Detention</th>
                    <th className="py-2.5 pl-3 text-right">Batch Lock Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {driverLoads.map((l) => (
                    <tr key={l.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 pr-3 font-mono font-semibold text-white">{l.loadNumber}</td>
                      <td className="py-3 px-3">
                        <span className="px-2 py-0.5 rounded-md bg-white/[0.06] text-slate-200 font-mono text-[11px]">
                          {l.status}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-200">{l.loadedMiles} mi</td>
                      <td className="py-3 px-3 font-mono text-slate-300">{l.detentionMinutes} min</td>
                      <td className="py-3 pl-3 text-right">
                        {l.settlementBatchId ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 font-mono text-[11px]">
                            <Lock className="w-3 h-3" />
                            Locked ({l.settlementBatchId.slice(0, 10)})
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-bro-gold/15 border border-bro-gold/40 text-bro-gold font-mono text-[11px]">
                            Eligible for Payout
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Finalized Settlement Statements Archive */}
      <div className="surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
            <FileText className="w-4 h-4 text-bro-cyan" />
            <span>Finalized Driver Settlement Statements &amp; PDFs</span>
          </h2>
          <span className="text-xs text-slate-400">{settlements.length} statement(s) archived</span>
        </div>

        {settlements.length === 0 ? (
          <div className="p-6 rounded-xl border border-white/10 bg-slate-950/60 text-xs text-slate-400 text-center">
            No finalized settlement statements yet. Select a driver above to issue a settlement statement.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/10 text-[11px] font-mono uppercase text-slate-400">
                  <th className="py-2.5 pr-3">Statement #</th>
                  <th className="py-2.5 px-3">Driver</th>
                  <th className="py-2.5 px-3">Period</th>
                  <th className="py-2.5 px-3">Gross Pay</th>
                  <th className="py-2.5 px-3">Deductions</th>
                  <th className="py-2.5 px-3">Net Pay</th>
                  <th className="py-2.5 pl-3 text-right">Statement PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {settlements.map((s) => {
                  const drv = drivers.find((d) => d.id === s.driverId);
                  return (
                    <tr key={s.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 pr-3 font-mono font-semibold text-white">
                        {s.settlementNumber}
                      </td>
                      <td className="py-3 px-3 text-slate-200">{drv?.fullName ?? s.driverId}</td>
                      <td className="py-3 px-3 font-mono text-slate-400">
                        {new Date(s.periodStart).toISOString().slice(0, 10)} &rarr;{' '}
                        {new Date(s.periodEnd).toISOString().slice(0, 10)}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-200">
                        {formatCents(s.grossPayCents, s.currency)}
                      </td>
                      <td className="py-3 px-3 font-mono text-rose-300">
                        -{formatCents(s.deductionsCents, s.currency)}
                      </td>
                      <td className="py-3 px-3 font-mono font-bold text-emerald-400">
                        {formatCents(s.netPayCents, s.currency)}
                      </td>
                      <td className="py-3 pl-3 text-right">
                        <a
                          href={`/api/settlements/${s.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-bro-cyan/40 bg-bro-cyan/10 hover:bg-bro-cyan/20 text-bro-cyan font-semibold text-xs transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>PDF</span>
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
