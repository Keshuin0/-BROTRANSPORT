import { useState, useEffect, useCallback, useRef, type ComponentType, type SyntheticEvent } from 'react';
import {
  CheckCircle2,
  CreditCard,
  DollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  Fuel,
  Plus,
  Receipt,
  RefreshCw,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import {
  IFTA_DIESEL_RATE_CENTS_PER_GAL,
  type DriverPayModel,
  type EquipmentType,
  type IftaQuarterReport,
  type InvoiceStatus,
  type LoadDirection,
  type LoadStatus,
} from '@bro/contracts';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  loadId: string;
  shipperOrgId: string;
  currency: 'CAD' | 'USD';
  subtotalCents: number;
  taxCents: number;
  taxLabel: string;
  totalCents: number;
  status: InvoiceStatus;
  dueDate: number;
  paidAt: number | null;
  paymentRef: string | null;
  invoicePdfR2Key: string | null;
  factoringPacketR2Key: string | null;
  createdAt: number;
}

interface AgingBuckets {
  currentCents: number;
  days1To30Cents: number;
  days31To60Cents: number;
  days61To90Cents: number;
  over90Cents: number;
}

interface LoadRow {
  id: string;
  loadNumber: string;
  shipperOrgId: string;
  tractorId: string | null;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  status: LoadStatus;
  commodity: string;
  loadedMiles: number;
  rateCustomerCents: number;
  rateCarrierCents: number;
  currency: 'CAD' | 'USD';
}

interface OrgRow {
  id: string;
  name: string;
  currency: 'CAD' | 'USD';
}

interface DriverRow {
  id: string;
  fullName: string;
  equipmentDivision: EquipmentType;
  payModel: DriverPayModel;
  payRateValue: number;
  status: string;
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

interface EquipmentSummary {
  id: string;
  unitNumber: string;
  type: string;
}

type BillingTab = 'invoices' | 'settlements' | 'ifta' | 'pnl';

const QUARTERS = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'] as const;
const IFTA_JURISDICTIONS = Object.keys(IFTA_DIESEL_RATE_CENTS_PER_GAL).sort();

function formatCents(cents: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  const formatted = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}$${formatted} ${currency}`;
}

function formatCentsShort(cents: number): string {
  const formatted = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}$${formatted}`;
}

function formatDateIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export default function BillingAccountingDesk() {
  const [activeTab, setActiveTab] = useState<BillingTab>('invoices');
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Billing & AR state
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [aging, setAging] = useState<AgingBuckets>({
    currentCents: 0,
    days1To30Cents: 0,
    days31To60Cents: 0,
    days61To90Cents: 0,
    over90Cents: 0,
  });
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [tractors, setTractors] = useState<EquipmentSummary[]>([]);
  const [busyInvoiceId, setBusyInvoiceId] = useState<string | null>(null);

  // Mark Paid Modal state
  const [payModalInv, setPayModalInv] = useState<InvoiceRow | null>(null);
  const [paymentRef, setPaymentRef] = useState('EFT/ACH-CLEARED');
  const payInputRef = useRef<HTMLInputElement | null>(null);

  // Driver Settlements state
  const [settlements, setSettlements] = useState<SettlementRow[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [fuelDeductionDollars, setFuelDeductionDollars] = useState('0.00');
  const [insuranceDeductionDollars, setInsuranceDeductionDollars] = useState('0.00');
  const [settleBusy, setSettleBusy] = useState(false);

  // IFTA Quarterly Tax state
  const [quarter, setQuarter] = useState<string>('2026-Q4');
  const [iftaReport, setIftaReport] = useState<IftaQuarterReport | null>(null);
  const [iftaRawCount, setIftaRawCount] = useState(0);
  const [iftaBusy, setIftaBusy] = useState(false);
  const [iftaForm, setIftaForm] = useState({
    tractorId: 'eq_trc_101',
    loadId: '',
    jurisdictionCode: 'PE',
    distanceKm: '240',
    fuelLiters: '150',
    fuelCostDollars: '265.00',
  });

  const fetchBillingCore = useCallback(async () => {
    try {
      const [invRes, stlRes, loadRes] = await Promise.all([
        fetch('/api/ops/billing/invoices'),
        fetch('/api/ops/settlements'),
        fetch('/api/ops/loads'),
      ]);

      if (invRes.ok) {
        const invData = (await invRes.json()) as {
          invoices: InvoiceRow[];
          aging: AgingBuckets;
          loads: LoadRow[];
          organizations: OrgRow[];
        };
        setInvoices(invData.invoices || []);
        setAging(invData.aging);
        setLoads(invData.loads || []);
        setOrgs(invData.organizations || []);
      } else {
        const err = (await invRes.json().catch(() => ({}))) as { error?: string };
        setBanner({ kind: 'error', text: err.error || `Billing API denied (HTTP ${invRes.status}).` });
      }

      if (stlRes.ok) {
        const stlData = (await stlRes.json()) as {
          settlements: SettlementRow[];
          drivers: DriverRow[];
        };
        setSettlements(stlData.settlements || []);
        setDrivers(stlData.drivers || []);
        setSelectedDriverId((prev) => prev || stlData.drivers?.[0]?.id || '');
      }

      if (loadRes.ok) {
        const lData = (await loadRes.json()) as { equipment?: EquipmentSummary[] };
        const trcList = (lData.equipment || []).filter((e) => e.type === 'tractor');
        setTractors(trcList);
        if (trcList.length > 0) {
          setIftaForm((prev) => ({
            ...prev,
            tractorId: trcList.some((t) => t.id === prev.tractorId) ? prev.tractorId : trcList[0].id,
          }));
        }
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error communicating with Billing & Payroll API.' });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchIfta = useCallback(async (targetQuarter: string) => {
    try {
      const res = await fetch(`/api/ops/ifta/report?quarter=${encodeURIComponent(targetQuarter)}`);
      if (res.ok) {
        const data = (await res.json()) as { report: IftaQuarterReport; rawLogsCount: number };
        setIftaReport(data.report);
        setIftaRawCount(data.rawLogsCount);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error fetching quarterly IFTA report.' });
    }
  }, []);

  useEffect(() => {
    void fetchBillingCore();
  }, [fetchBillingCore]);

  useEffect(() => {
    void fetchIfta(quarter);
  }, [quarter, fetchIfta]);

  useEffect(() => {
    if (payModalInv) {
      payInputRef.current?.focus();
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && payModalInv) setPayModalInv(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [payModalInv]);

  const handleApproveInvoice = async (inv: InvoiceRow) => {
    setBusyInvoiceId(inv.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/billing/invoices/${encodeURIComponent(inv.id)}/approve`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Invoice approval failed.' });
      } else {
        setBanner({
          kind: 'success',
          text: `Invoice ${inv.invoiceNumber} approved — Invoice PDF & Factoring Packet PDF archived in R2.`,
        });
        await fetchBillingCore();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error approving invoice.' });
    } finally {
      setBusyInvoiceId(null);
    }
  };

  const handleMarkPaidSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!payModalInv) return;
    setBusyInvoiceId(payModalInv.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/billing/invoices/${encodeURIComponent(payModalInv.id)}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentRef: paymentRef.trim() || 'EFT/ACH-CLEARED' }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Failed to mark invoice paid.' });
      } else {
        setBanner({
          kind: 'success',
          text: `Invoice ${payModalInv.invoiceNumber} settled (Ref: ${paymentRef.trim() || 'EFT/ACH-CLEARED'}) & load transitioned to PAID.`,
        });
        setPayModalInv(null);
        await fetchBillingCore();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error marking invoice paid.' });
    } finally {
      setBusyInvoiceId(null);
    }
  };

  const handleGenerateSettlement = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedDriverId) return;
    setSettleBusy(true);
    setBanner(null);

    const fuelDeductionCents = Math.max(0, Math.round(Number(fuelDeductionDollars || '0') * 100));
    const insuranceDeductionCents = Math.max(0, Math.round(Number(insuranceDeductionDollars || '0') * 100));

    try {
      const res = await fetch('/api/ops/settlements/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId: selectedDriverId,
          fuelDeductionCents: fuelDeductionCents || undefined,
          insuranceDeductionCents: insuranceDeductionCents || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        settlementNumber?: string;
        calculation?: { netPayCents: number };
      };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Failed to generate settlement statement.' });
      } else {
        setBanner({
          kind: 'success',
          text: `Generated Statement ${data.settlementNumber} (Net Pay: ${formatCents(data.calculation?.netPayCents ?? 0, 'CAD')}). PDF ready.`,
        });
        await fetchBillingCore();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error generating driver settlement.' });
    } finally {
      setSettleBusy(false);
    }
  };

  const handleAddIftaLog = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIftaBusy(true);
    setBanner(null);

    const payload = {
      tractorId: iftaForm.tractorId.trim(),
      loadId: iftaForm.loadId.trim() || undefined,
      quarter,
      jurisdictionCode: iftaForm.jurisdictionCode.toUpperCase(),
      distanceKm: Math.max(0, Number(iftaForm.distanceKm) || 0),
      fuelLiters: Math.max(0, Number(iftaForm.fuelLiters) || 0),
      fuelCostCents: Math.max(0, Math.round((Number(iftaForm.fuelCostDollars) || 0) * 100)),
    };

    try {
      const res = await fetch('/api/ops/ifta/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Failed to record IFTA mileage/fuel log.' });
      } else {
        setBanner({
          kind: 'success',
          text: `Recorded ${payload.distanceKm} km & ${payload.fuelLiters} L in ${payload.jurisdictionCode} for ${quarter}.`,
        });
        await fetchIfta(quarter);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error submitting IFTA log.' });
    } finally {
      setIftaBusy(false);
    }
  };

  const orgMap = new Map(orgs.map((o) => [o.id, o]));
  const loadMap = new Map(loads.map((l) => [l.id, l]));
  const driverMap = new Map(drivers.map((d) => [d.id, d]));

  // Aggregate P&L math strictly in integer cents
  const pnlTotals = loads.reduce(
    (acc, l) => {
      acc.revCents += l.rateCustomerCents;
      acc.costCents += l.rateCarrierCents;
      return acc;
    },
    { revCents: 0, costCents: 0 },
  );
  const totalProfitCents = pnlTotals.revCents - pnlTotals.costCents;
  const blendedMarginPct =
    pnlTotals.revCents > 0 ? ((totalProfitCents / pnlTotals.revCents) * 100).toFixed(1) : '0.0';

  const tabs: Array<{ id: BillingTab; label: string; icon: ComponentType<{ className?: string }> }> = [
    { id: 'invoices', label: 'Invoices & AR Aging', icon: Receipt },
    { id: 'settlements', label: 'Driver Settlements', icon: Users },
    { id: 'ifta', label: 'IFTA Quarterly Tax', icon: Fuel },
    { id: 'pnl', label: 'Load P&L Margin', icon: TrendingUp },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-cyan">
            MODULE 04 // INTEGER-CENT ACCOUNTING · FACTORING · PAYROLL · IFTA
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            Billing, Settlements &amp; IFTA Tax Desk
          </h1>
        </div>
        <button
          type="button"
          onClick={() => {
            void fetchBillingCore();
            void fetchIfta(quarter);
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 font-mono text-xs text-white cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Sync Ledgers
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

      {/* 4-Tab Navigation */}
      <div role="tablist" aria-label="Billing and Accounting Modules" className="flex flex-wrap gap-2 border-b border-white/10 pb-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded font-mono text-xs uppercase transition-colors border cursor-pointer ${
                active
                  ? 'bg-bro-cyan/15 border-bro-cyan/50 text-bro-cyan font-bold'
                  : 'bg-bro-steel/50 border-white/10 text-slate-300 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB A: INVOICES & AR AGING */}
      {activeTab === 'invoices' && (
        <div className="space-y-6">
          {/* AR Aging KPI Strip */}
          <section aria-label="Accounts Receivable Aging Buckets" className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Current (Not Due)', cents: aging.currentCents, cls: 'text-bro-cyan border-bro-cyan/30' },
              { label: '1–30 Days Overdue', cents: aging.days1To30Cents, cls: 'text-emerald-300 border-emerald-500/30' },
              { label: '31–60 Days Overdue', cents: aging.days31To60Cents, cls: 'text-bro-gold border-bro-gold/35' },
              { label: '61–90 Days Overdue', cents: aging.days61To90Cents, cls: 'text-amber-400 border-amber-500/35' },
              { label: '90+ Days Critical', cents: aging.over90Cents, cls: 'text-bro-crimson border-bro-crimson/40' },
            ].map((bucket) => (
              <div key={bucket.label} className={`glass-panel rounded-lg p-4 border ${bucket.cls}`}>
                <div className="font-mono text-[10px] uppercase text-slate-400">{bucket.label}</div>
                <div className="text-xl font-bold font-mono tabular-nums mt-2">{formatCentsShort(bucket.cents)}</div>
              </div>
            ))}
          </section>

          {/* Invoices Table */}
          <section aria-label="Accounts Receivable Invoices" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                AR Invoices &amp; Factoring Packet Pipeline ({invoices.length})
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                    <th className="px-4 py-2.5">Invoice # / Load</th>
                    <th className="px-4 py-2.5">Shipper Account</th>
                    <th className="px-4 py-2.5 text-right">Subtotal / Tax</th>
                    <th className="px-4 py-2.5 text-right">Total Due</th>
                    <th className="px-4 py-2.5">Due / Status</th>
                    <th className="px-4 py-2.5 text-right">Workflow &amp; PDFs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {invoices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center font-mono text-slate-500">
                        {loading ? 'Loading accounts receivable ledger...' : 'No invoices generated yet.'}
                      </td>
                    </tr>
                  ) : (
                    invoices.map((inv) => {
                      const org = orgMap.get(inv.shipperOrgId);
                      const load = loadMap.get(inv.loadId);
                      const isBusy = busyInvoiceId === inv.id;
                      const needsApproval = inv.status === 'pending_approval' || inv.status === 'draft';
                      return (
                        <tr key={inv.id} className="hover:bg-white/5">
                          <td className="px-4 py-3 font-mono whitespace-nowrap">
                            <div className="font-bold text-white">{inv.invoiceNumber}</div>
                            <div className="text-[10px] text-slate-400">{load?.loadNumber || inv.loadId}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-slate-100">{org?.name || inv.shipperOrgId}</div>
                            <div className="font-mono text-[10px] text-slate-400">{inv.taxLabel}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                            <div className="text-slate-200">{formatCents(inv.subtotalCents, inv.currency)}</div>
                            <div className="text-[10px] text-slate-400">Tax: {formatCents(inv.taxCents, inv.currency)}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold tabular-nums text-white whitespace-nowrap">
                            {formatCents(inv.totalCents, inv.currency)}
                          </td>
                          <td className="px-4 py-3 font-mono whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded border text-[10px] uppercase font-bold ${
                                inv.status === 'paid'
                                  ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
                                  : inv.status === 'pending_approval'
                                    ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                                    : 'bg-bro-cyan/15 border-bro-cyan/45 text-bro-cyan'
                              }`}
                            >
                              {inv.status.replace(/_/g, ' ')}
                            </span>
                            <div className="text-[10px] text-slate-400 mt-1 tabular-nums">
                              Due {formatDateIso(inv.dueDate)}
                              {inv.paymentRef ? ` · ${inv.paymentRef}` : ''}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <div className="inline-flex flex-wrap justify-end gap-1.5">
                              {needsApproval && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleApproveInvoice(inv)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-[10px] font-bold uppercase hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  Approve &amp; Assemble Packet
                                </button>
                              )}
                              {inv.status !== 'paid' && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => {
                                    setPaymentRef('EFT/ACH-CLEARED');
                                    setPayModalInv(inv);
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-500/45 font-mono text-[10px] font-bold uppercase text-emerald-300 cursor-pointer disabled:opacity-50"
                                >
                                  <CreditCard className="w-3 h-3" />
                                  Mark Paid
                                </button>
                              )}
                              <a
                                href={`/api/billing/invoices/${encodeURIComponent(inv.id)}/pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-bro-steel hover:bg-slate-800 border border-white/15 font-mono text-[10px] text-white"
                              >
                                <FileText className="w-3 h-3 text-bro-cyan" />
                                Invoice PDF
                              </a>
                              <a
                                href={`/api/ops/billing/invoices/${encodeURIComponent(inv.id)}/factoring-packet.pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded border font-mono text-[10px] ${
                                  inv.factoringPacketR2Key || inv.status === 'sent' || inv.status === 'paid'
                                    ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold hover:bg-bro-gold/25 font-bold'
                                    : 'bg-slate-900 border-white/10 text-slate-500'
                                }`}
                              >
                                <Download className="w-3 h-3" />
                                Factoring Packet PDF
                              </a>
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
        </div>
      )}

      {/* TAB B: DRIVER SETTLEMENTS */}
      {activeTab === 'settlements' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Settlement Generator Form */}
          <section aria-label="Generate Driver Settlement Statement" className="xl:col-span-4 glass-panel rounded-lg border border-white/10 p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-white/10 pb-3">
              <DollarSign className="w-4 h-4 text-bro-gold" />
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                Generate Driver Settlement Statement
              </h2>
            </div>

            <form onSubmit={handleGenerateSettlement} className="space-y-4">
              <div>
                <label htmlFor="stl-driver" className="block font-mono text-[10px] uppercase text-slate-400 mb-1">
                  Select Driver / Owner-Operator
                </label>
                <select
                  id="stl-driver"
                  required
                  value={selectedDriverId}
                  onChange={(e) => setSelectedDriverId(e.target.value)}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white"
                >
                  <option value="">-- Select Driver --</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.fullName} —{' '}
                      {d.payModel === 'cpm'
                        ? `$${(d.payRateValue / 100).toFixed(2)}/mi CPM`
                        : `${(d.payRateValue / 100).toFixed(2)}% Gross`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="stl-fuel" className="block font-mono text-[10px] uppercase text-slate-400 mb-1">
                  Fleet Fuel Card Deduction ($ CAD)
                </label>
                <input
                  id="stl-fuel"
                  type="number"
                  step="0.01"
                  min="0"
                  value={fuelDeductionDollars}
                  onChange={(e) => setFuelDeductionDollars(e.target.value)}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="stl-ins" className="block font-mono text-[10px] uppercase text-slate-400 mb-1">
                  Occupational Insurance / Escrow Deduction ($ CAD)
                </label>
                <input
                  id="stl-ins"
                  type="number"
                  step="0.01"
                  min="0"
                  value={insuranceDeductionDollars}
                  onChange={(e) => setInsuranceDeductionDollars(e.target.value)}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white tabular-nums"
                />
              </div>

              <button
                type="submit"
                disabled={settleBusy || !selectedDriverId}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-bro-gold text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-amber-400 cursor-pointer disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                {settleBusy ? 'Rendering PDF Statement...' : 'Generate Statement PDF'}
              </button>
            </form>
          </section>

          {/* Settlements History */}
          <section aria-label="Driver Settlements Ledger" className="xl:col-span-8 glass-panel rounded-lg border border-white/10 overflow-hidden">
            <div className="p-4 border-b border-white/10">
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                Finalized Driver Settlements ({settlements.length})
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                    <th className="px-4 py-2.5">Statement #</th>
                    <th className="px-4 py-2.5">Driver &amp; Period</th>
                    <th className="px-4 py-2.5 text-right">Gross Pay</th>
                    <th className="px-4 py-2.5 text-right">Deductions</th>
                    <th className="px-4 py-2.5 text-right">Net Pay</th>
                    <th className="px-4 py-2.5 text-right">PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs font-mono">
                  {settlements.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        No driver settlements generated yet. Select a driver to render a statement PDF.
                      </td>
                    </tr>
                  ) : (
                    settlements.map((stl) => {
                      const drv = driverMap.get(stl.driverId);
                      return (
                        <tr key={stl.id} className="hover:bg-white/5">
                          <td className="px-4 py-3 font-bold text-white whitespace-nowrap">{stl.settlementNumber}</td>
                          <td className="px-4 py-3">
                            <div className="text-slate-100">{drv?.fullName || stl.driverId}</div>
                            <div className="text-[10px] text-slate-400 tabular-nums">
                              {formatDateIso(stl.periodStart)} to {formatDateIso(stl.periodEnd)}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-200 whitespace-nowrap">
                            {formatCents(stl.grossPayCents, stl.currency)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-rose-300 whitespace-nowrap">
                            -{formatCents(stl.deductionsCents, stl.currency)}
                          </td>
                          <td className="px-4 py-3 text-right font-bold tabular-nums text-emerald-300 whitespace-nowrap">
                            {formatCents(stl.netPayCents, stl.currency)}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <a
                              href={`/api/settlements/${encodeURIComponent(stl.id)}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-bro-steel hover:bg-slate-800 border border-white/15 text-[10px] text-bro-cyan font-bold"
                            >
                              <Download className="w-3 h-3" />
                              PDF
                            </a>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* TAB C: IFTA QUARTERLY TAX */}
      {activeTab === 'ifta' && (
        <div className="space-y-6">
          {/* Quarter Selector & CSV Export */}
          <div className="flex flex-wrap items-center justify-between gap-3 glass-panel rounded-lg p-4 border border-white/10">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs uppercase text-slate-400">Filing Quarter:</span>
              {QUARTERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuarter(q)}
                  className={`px-3 py-1.5 rounded font-mono text-xs border cursor-pointer ${
                    quarter === q
                      ? 'bg-bro-cyan/20 border-bro-cyan text-bro-cyan font-bold'
                      : 'bg-bro-obsidian border-white/10 text-slate-400 hover:text-white'
                  }`}
                >
                  {q}
                </button>
              ))}
              <span className="font-mono text-[11px] text-slate-400 ml-2 tabular-nums">
                ({iftaRawCount} fuel/mileage logs)
              </span>
            </div>

            <a
              href={`/api/ops/ifta/report.csv?quarter=${encodeURIComponent(quarter)}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded bg-bro-gold text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-amber-400"
            >
              <FileSpreadsheet className="w-4 h-4" />
              Export IFTA CSV ({quarter})
            </a>
          </div>

          {/* IFTA Summary KPIs */}
          {iftaReport && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="glass-panel rounded-lg p-4 border border-white/10">
                <div className="font-mono text-[10px] uppercase text-slate-400">Total Fleet Miles</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                  {iftaReport.totalMiles.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mi
                </div>
              </div>
              <div className="glass-panel rounded-lg p-4 border border-white/10">
                <div className="font-mono text-[10px] uppercase text-slate-400">Tax-Paid Fuel Purchased</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-bro-cyan mt-1">
                  {iftaReport.totalGallons.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} gal
                </div>
              </div>
              <div className="glass-panel rounded-lg p-4 border border-white/10">
                <div className="font-mono text-[10px] uppercase text-slate-400">Fleet Average MPG</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                  {iftaReport.fleetMpg.toFixed(2)} MPG
                </div>
              </div>
              <div className="glass-panel rounded-lg p-4 border border-bro-gold/35">
                <div className="font-mono text-[10px] uppercase text-slate-400">Net IFTA Tax Due / (Credit)</div>
                <div
                  className={`text-2xl font-bold font-mono tabular-nums mt-1 ${
                    iftaReport.totalNetTaxDueCents > 0 ? 'text-bro-crimson' : 'text-emerald-300'
                  }`}
                >
                  {formatCents(iftaReport.totalNetTaxDueCents, 'USD')}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            {/* Add Mileage / Fuel Log Form */}
            <section aria-label="Record IFTA Mileage and Fuel Log" className="xl:col-span-4 glass-panel rounded-lg border border-white/10 p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                <Plus className="w-4 h-4 text-bro-cyan" />
                <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                  Add Jurisdiction Log ({quarter})
                </h2>
              </div>

              <form onSubmit={handleAddIftaLog} className="space-y-3">
                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Tractor Unit</label>
                  {tractors.length > 0 ? (
                    <select
                      value={iftaForm.tractorId}
                      onChange={(e) => setIftaForm({ ...iftaForm, tractorId: e.target.value })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white"
                    >
                      {tractors.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.unitNumber} ({t.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      value={iftaForm.tractorId}
                      onChange={(e) => setIftaForm({ ...iftaForm, tractorId: e.target.value })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white"
                    />
                  )}
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Jurisdiction (State / Prov)</label>
                  <select
                    value={iftaForm.jurisdictionCode}
                    onChange={(e) => setIftaForm({ ...iftaForm, jurisdictionCode: e.target.value })}
                    className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white"
                  >
                    {IFTA_JURISDICTIONS.map((jur) => (
                      <option key={jur} value={jur}>
                        {jur} — ${(IFTA_DIESEL_RATE_CENTS_PER_GAL[jur] / 100).toFixed(2)} USD/gal
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Distance (km)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      required
                      value={iftaForm.distanceKm}
                      onChange={(e) => setIftaForm({ ...iftaForm, distanceKm: e.target.value })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Fuel (Liters)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={iftaForm.fuelLiters}
                      onChange={(e) => setIftaForm({ ...iftaForm, fuelLiters: e.target.value })}
                      className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white tabular-nums"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Receipt Fuel Cost ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={iftaForm.fuelCostDollars}
                    onChange={(e) => setIftaForm({ ...iftaForm, fuelCostDollars: e.target.value })}
                    className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white tabular-nums"
                  />
                </div>

                <button
                  type="submit"
                  disabled={iftaBusy}
                  className="w-full px-4 py-2.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                >
                  {iftaBusy ? 'Logging Entry...' : 'Record IFTA Entry'}
                </button>
              </form>
            </section>

            {/* Jurisdiction Breakdown Table */}
            <section aria-label="IFTA Jurisdiction Breakdown" className="xl:col-span-8 glass-panel rounded-lg border border-white/10 overflow-hidden">
              <div className="p-4 border-b border-white/10">
                <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                  Jurisdiction Breakdown — {quarter}
                </h2>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                      <th className="px-4 py-2.5">Jurisdiction</th>
                      <th className="px-4 py-2.5 text-right">Miles</th>
                      <th className="px-4 py-2.5 text-right">Taxable Gal</th>
                      <th className="px-4 py-2.5 text-right">Tax-Paid Gal</th>
                      <th className="px-4 py-2.5 text-right">Net Gal</th>
                      <th className="px-4 py-2.5 text-right">Rate ($/gal)</th>
                      <th className="px-4 py-2.5 text-right">Net Tax Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs font-mono tabular-nums">
                    {!iftaReport || iftaReport.jurisdictions.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                          No IFTA jurisdiction logs recorded for {quarter}.
                        </td>
                      </tr>
                    ) : (
                      iftaReport.jurisdictions.map((j) => (
                        <tr key={j.jurisdictionCode} className="hover:bg-white/5">
                          <td className="px-4 py-3 font-bold text-white">{j.jurisdictionCode}</td>
                          <td className="px-4 py-3 text-right text-slate-200">{j.miles.toFixed(2)}</td>
                          <td className="px-4 py-3 text-right text-slate-300">{j.taxableGallons.toFixed(2)}</td>
                          <td className="px-4 py-3 text-right text-bro-cyan">{j.taxPaidGallons.toFixed(2)}</td>
                          <td className="px-4 py-3 text-right text-slate-200">{j.netTaxableGallons.toFixed(2)}</td>
                          <td className="px-4 py-3 text-right text-slate-400">
                            ${(j.taxRateCentsPerGal / 100).toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-3 text-right font-bold ${
                              j.netTaxDueCents > 0 ? 'text-bro-crimson' : 'text-emerald-300'
                            }`}
                          >
                            {formatCents(j.netTaxDueCents, 'USD')}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* TAB D: LOAD P&L MARGIN */}
      {activeTab === 'pnl' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-panel rounded-lg p-4 border border-bro-cyan/30">
              <div className="font-mono text-[10px] uppercase text-slate-400">Gross Customer Revenue</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                {formatCentsShort(pnlTotals.revCents)}
              </div>
            </div>
            <div className="glass-panel rounded-lg p-4 border border-white/10">
              <div className="font-mono text-[10px] uppercase text-slate-400">Carrier / Driver Cost</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-slate-200 mt-1">
                {formatCentsShort(pnlTotals.costCents)}
              </div>
            </div>
            <div className="glass-panel rounded-lg p-4 border border-emerald-500/35">
              <div className="font-mono text-[10px] uppercase text-slate-400">Net Gross Profit</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-emerald-300 mt-1">
                {formatCentsShort(totalProfitCents)}
              </div>
            </div>
            <div className="glass-panel rounded-lg p-4 border border-bro-gold/35">
              <div className="font-mono text-[10px] uppercase text-slate-400">Blended Net Margin</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-bro-gold mt-1">
                {blendedMarginPct}%
              </div>
            </div>
          </div>

          <section aria-label="Per-Load Profit and Loss Table" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
            <div className="p-4 border-b border-white/10">
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                Per-Load Revenue vs. Carrier/Driver Cost &amp; Net Margin ({loads.length} loads)
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                    <th className="px-4 py-2.5">Load # / Division</th>
                    <th className="px-4 py-2.5">Shipper</th>
                    <th className="px-4 py-2.5 text-right">Loaded Miles</th>
                    <th className="px-4 py-2.5 text-right">Customer Rev</th>
                    <th className="px-4 py-2.5 text-right">Carrier Cost</th>
                    <th className="px-4 py-2.5 text-right">Net Profit</th>
                    <th className="px-4 py-2.5 text-right">Margin %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs font-mono tabular-nums">
                  {loads.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        No loads available for P&amp;L analysis.
                      </td>
                    </tr>
                  ) : (
                    loads.map((l) => {
                      const profitCents = l.rateCustomerCents - l.rateCarrierCents;
                      const marginPct =
                        l.rateCustomerCents > 0 ? (profitCents / l.rateCustomerCents) * 100 : 0;
                      const org = orgMap.get(l.shipperOrgId);
                      const marginBadge =
                        marginPct >= 25
                          ? 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40'
                          : marginPct >= 15
                            ? 'bg-bro-gold/15 text-bro-gold border-bro-gold/40'
                            : 'bg-bro-crimson/15 text-bro-crimson border-bro-crimson/40';
                      return (
                        <tr key={l.id} className="hover:bg-white/5">
                          <td className="px-4 py-3">
                            <div className="font-bold text-white">{l.loadNumber}</div>
                            <div className="text-[10px] text-slate-400 uppercase">
                              {l.equipmentType.replace(/_/g, ' ')} · {l.status}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-sans text-slate-200">{org?.name || l.shipperOrgId}</td>
                          <td className="px-4 py-3 text-right text-slate-300">{l.loadedMiles.toLocaleString()} mi</td>
                          <td className="px-4 py-3 text-right text-white">
                            {formatCents(l.rateCustomerCents, l.currency)}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-300">
                            {formatCents(l.rateCarrierCents, l.currency)}
                          </td>
                          <td
                            className={`px-4 py-3 text-right font-bold ${
                              profitCents >= 0 ? 'text-emerald-300' : 'text-bro-crimson'
                            }`}
                          >
                            {formatCents(profitCents, l.currency)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${marginBadge}`}>
                              {marginPct.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* Accessible Mark Paid Modal (replaces browser prompt) */}
      {payModalInv && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mark-paid-title"
        >
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setPayModalInv(null)} />
          <div className="relative z-10 w-full max-w-md rounded-lg bg-bro-obsidian border border-emerald-500/40 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 id="mark-paid-title" className="font-mono text-sm font-bold text-white uppercase">
                Record Settlement Payment — {payModalInv.invoiceNumber}
              </h3>
              <button
                type="button"
                onClick={() => setPayModalInv(null)}
                aria-label="Close payment modal"
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleMarkPaidSubmit} className="p-5 space-y-4">
              <div className="p-3 rounded bg-bro-steel/70 border border-white/10 font-mono text-xs flex justify-between">
                <span className="text-slate-400">Amount Settled:</span>
                <span className="font-bold text-emerald-300 tabular-nums">
                  {formatCents(payModalInv.totalCents, payModalInv.currency)}
                </span>
              </div>
              <div>
                <label htmlFor="payment-ref-input" className="block font-mono text-[10px] uppercase text-slate-400 mb-1">
                  EFT / ACH / Factoring Wire Reference
                </label>
                <input
                  id="payment-ref-input"
                  ref={payInputRef}
                  type="text"
                  required
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  className="w-full rounded bg-bro-steel border border-white/15 focus:border-emerald-400 px-3 py-2 font-mono text-xs text-white outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setPayModalInv(null)}
                  className="px-4 py-2 rounded border border-white/15 font-mono text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyInvoiceId === payModalInv.id}
                  className="px-4 py-2 rounded bg-emerald-500 text-bro-obsidian font-mono text-xs font-bold uppercase hover:bg-emerald-400 cursor-pointer disabled:opacity-50"
                >
                  Confirm Payment Received
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
