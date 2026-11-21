import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react';
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
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

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

interface CreateInvoiceFormState {
  loadId: string;
  shipperOrgId: string;
  currency: 'CAD' | 'USD';
  direction: LoadDirection;
  destinationProvince: string;
  dueDays: string;
  itemCode: string;
  itemDescription: string;
  amountDollars: string;
}

type BillingTab = 'invoices' | 'settlements' | 'ifta' | 'pnl';

const QUARTERS = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'] as const;
const IFTA_JURISDICTIONS = Object.keys(IFTA_DIESEL_RATE_CENTS_PER_GAL).sort();

function createEmptyInvoiceForm(): CreateInvoiceFormState {
  return {
    loadId: '',
    shipperOrgId: '',
    currency: 'CAD',
    direction: 'ca_to_us',
    destinationProvince: 'PE',
    dueDays: '30',
    itemCode: 'FREIGHT',
    itemDescription: '',
    amountDollars: '',
  };
}

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

  // Create Invoice Modal state
  const [createInvOpen, setCreateInvOpen] = useState(false);
  const [createInvBusy, setCreateInvBusy] = useState(false);
  const [createInvError, setCreateInvError] = useState<string | null>(null);
  const [createInvForm, setCreateInvForm] = useState<CreateInvoiceFormState>(() => createEmptyInvoiceForm());
  const createInvLoadRef = useRef<HTMLSelectElement | null>(null);

  // Mark Paid Modal state
  const [payModalInv, setPayModalInv] = useState<InvoiceRow | null>(null);
  const [renderedPayInv, setRenderedPayInv] = useState<InvoiceRow | null>(null);
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
    tractorId: '',
    loadId: '',
    jurisdictionCode: 'PE',
    distanceKm: '240',
    fuelLiters: '150',
    fuelCostDollars: '265.00',
  });

  const closePayModal = useCallback(() => {
    setPayModalInv(null);
  }, []);

  const closeCreateInvModal = useCallback(() => {
    setCreateInvOpen(false);
  }, []);

  const payModal = useModalFocusTrap<HTMLDivElement, HTMLInputElement>({
    open: Boolean(payModalInv),
    onClose: closePayModal,
    initialFocusRef: payInputRef,
  });

  const createInvModal = useModalFocusTrap<HTMLDivElement, HTMLElement>({
    open: createInvOpen,
    onClose: closeCreateInvModal,
    initialFocusRef: createInvLoadRef as unknown as RefObject<HTMLElement | null>,
  });

  useEffect(() => {
    if (payModalInv) {
      setRenderedPayInv(payModalInv);
    }
  }, [payModalInv]);

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

  const handleOpenCreateInvoice = () => {
    setCreateInvError(null);
    const firstLoad = loads[0];
    if (firstLoad) {
      setCreateInvForm({
        loadId: firstLoad.id,
        shipperOrgId: firstLoad.shipperOrgId,
        currency: firstLoad.currency,
        direction: firstLoad.direction,
        destinationProvince: 'PE',
        dueDays: '30',
        itemCode: 'FREIGHT',
        itemDescription: `Commercial Freight Linehaul (${firstLoad.commodity})`,
        amountDollars: (firstLoad.rateCustomerCents / 100).toFixed(2),
      });
    } else {
      setCreateInvForm(createEmptyInvoiceForm());
    }
    setCreateInvOpen(true);
  };

  const handleCreateInvoiceLoadChange = (nextLoadId: string) => {
    const matched = loads.find((l) => l.id === nextLoadId);
    if (!matched) {
      setCreateInvForm((prev) => ({ ...prev, loadId: nextLoadId }));
      return;
    }
    setCreateInvForm((prev) => ({
      ...prev,
      loadId: matched.id,
      shipperOrgId: matched.shipperOrgId,
      currency: matched.currency,
      direction: matched.direction,
      itemDescription: `Commercial Freight Linehaul (${matched.commodity})`,
      amountDollars: (matched.rateCustomerCents / 100).toFixed(2),
    }));
  };

  const handleCreateInvoiceSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreateInvBusy(true);
    setCreateInvError(null);

    const amountCents = Math.round(Number(createInvForm.amountDollars) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 100) {
      setCreateInvError('Invoice line item amount must be at least $1.00.');
      setCreateInvBusy(false);
      return;
    }

    const dueDays = Math.max(0, Math.min(90, Math.round(Number(createInvForm.dueDays) || 30)));
    const payload = {
      loadId: createInvForm.loadId.trim(),
      shipperOrgId: createInvForm.shipperOrgId.trim(),
      currency: createInvForm.currency,
      direction: createInvForm.direction,
      destinationProvince:
        createInvForm.direction === 'domestic_ca' && createInvForm.destinationProvince.trim()
          ? createInvForm.destinationProvince.trim().toUpperCase()
          : undefined,
      dueDays,
      lineItems: [
        {
          code: createInvForm.itemCode.trim().toUpperCase() || 'FREIGHT',
          description: createInvForm.itemDescription.trim() || 'Commercial Freight Linehaul',
          quantity: 1,
          unitPriceCents: amountCents,
          amountCents,
        },
      ],
    };

    try {
      const res = await fetch('/api/ops/billing/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; invoiceNumber?: string };
      if (!res.ok) {
        setCreateInvError(data.error || `Failed to create invoice (HTTP ${res.status}).`);
      } else {
        setBanner({
          kind: 'success',
          text: `Invoice ${data.invoiceNumber} created in Pending Approval state.`,
        });
        setCreateInvOpen(false);
        await fetchBillingCore();
      }
    } catch {
      setCreateInvError('Network error creating invoice.');
    } finally {
      setCreateInvBusy(false);
    }
  };

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

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = tabs[(idx + 1) % tabs.length];
      setActiveTab(next.id);
      document.getElementById(`billing-tab-${next.id}`)?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      setActiveTab(prev.id);
      document.getElementById(`billing-tab-${prev.id}`)?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveTab(tabs[0].id);
      document.getElementById(`billing-tab-${tabs[0].id}`)?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = tabs[tabs.length - 1];
      setActiveTab(last.id);
      document.getElementById(`billing-tab-${last.id}`)?.focus();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-cyan">
            Integer-Cent Accounting · Factoring · Payroll · IFTA
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Billing, Settlements &amp; IFTA Tax Desk
          </h1>
        </div>
        <button
          type="button"
          onClick={() => {
            void fetchBillingCore();
            void fetchIfta(quarter);
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-xs font-semibold text-white cursor-pointer transition-colors"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          <span>Sync Ledgers</span>
        </button>
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

      {/* 4-Tab Navigation */}
      <div
        role="tablist"
        aria-label="Billing and Accounting Modules"
        className="flex flex-wrap gap-2 border-b border-white/10 pb-3"
      >
        {tabs.map((tab, idx) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`billing-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`billing-panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={`inline-flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-full text-xs font-semibold transition-colors border cursor-pointer ${
                active
                  ? 'bg-white text-black border-white shadow-sm'
                  : 'bg-[#0b1120] border-white/10 text-slate-300 hover:text-white hover:border-white/25'
              }`}
            >
              <Icon className="w-4 h-4" aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB A: INVOICES & AR AGING */}
      {activeTab === 'invoices' && (
        <div
          role="tabpanel"
          id="billing-panel-invoices"
          aria-labelledby="billing-tab-invoices"
          className="space-y-6"
        >
          {/* AR Aging KPI Strip */}
          <section
            aria-label="Accounts Receivable Aging Buckets"
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3"
          >
            {[
              { label: 'Current (Not Due)', cents: aging.currentCents, cls: 'text-bro-cyan border-bro-cyan/30' },
              { label: '1–30 Days Overdue', cents: aging.days1To30Cents, cls: 'text-emerald-200 border-emerald-400/30' },
              { label: '31–60 Days Overdue', cents: aging.days31To60Cents, cls: 'text-bro-gold border-bro-gold/35' },
              { label: '61–90 Days Overdue', cents: aging.days61To90Cents, cls: 'text-amber-300 border-amber-400/35' },
              { label: '90+ Days Critical', cents: aging.over90Cents, cls: 'text-rose-200 border-rose-400/50' },
            ].map((bucket) => (
              <div
                key={bucket.label}
                className={`surface-ceramic rounded-2xl p-4 border last:col-span-2 sm:last:col-span-1 ${bucket.cls}`}
              >
                <div className="text-xs font-medium text-slate-300">{bucket.label}</div>
                <div className="text-xl sm:text-2xl font-display font-bold tabular-nums mt-2">
                  {formatCentsShort(bucket.cents)}
                </div>
              </div>
            ))}
          </section>

          {/* Invoices Table */}
          <section aria-label="Accounts Receivable Invoices" className="surface-ceramic rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-base font-bold text-white">
                AR Invoices &amp; Factoring Packet Pipeline ({invoices.length})
              </h2>
              <button
                type="button"
                onClick={handleOpenCreateInvoice}
                className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer transition-colors"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>Create Invoice</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                    <th className="px-4 py-3">Invoice # / Load</th>
                    <th className="px-4 py-3">Shipper Account</th>
                    <th className="px-4 py-3 text-right">Subtotal / Tax</th>
                    <th className="px-4 py-3 text-right">Total Due</th>
                    <th className="px-4 py-3">Due / Status</th>
                    <th className="px-4 py-3 text-right">Workflow &amp; PDFs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs">
                  {invoices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-slate-300">
                        {loading ? 'Loading accounts receivable ledger...' : 'No invoices generated yet.'}
                      </td>
                    </tr>
                  ) : (
                    invoices.map((inv) => {
                      const org = orgMap.get(inv.shipperOrgId);
                      const load = loadMap.get(inv.loadId);
                      const isBusy = busyInvoiceId === inv.id;
                      const needsApproval = inv.status === 'pending_approval' || inv.status === 'draft';
                      const hasFactoringPacket = Boolean(inv.factoringPacketR2Key);
                      return (
                        <tr key={inv.id} className="hover:bg-white/[0.03]">
                          <td className="px-4 py-3.5 font-mono whitespace-nowrap">
                            <div className="font-bold text-white">{inv.invoiceNumber}</div>
                            <div className="text-xs text-slate-400 mt-0.5">{load?.loadNumber || inv.loadId}</div>
                          </td>
                          <td className="px-4 py-3.5">
                            <div className="text-sm font-medium text-slate-100">{org?.name || inv.shipperOrgId}</div>
                            <div className="text-xs text-slate-400 mt-0.5">{inv.taxLabel}</div>
                          </td>
                          <td className="px-4 py-3.5 text-right font-mono tabular-nums whitespace-nowrap">
                            <div className="text-slate-200">{formatCents(inv.subtotalCents, inv.currency)}</div>
                            <div className="text-xs text-slate-400 mt-0.5">Tax: {formatCents(inv.taxCents, inv.currency)}</div>
                          </td>
                          <td className="px-4 py-3.5 text-right font-mono font-bold tabular-nums text-white whitespace-nowrap">
                            {formatCents(inv.totalCents, inv.currency)}
                          </td>
                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <span
                              className={`px-2.5 py-1 rounded-full border text-xs uppercase font-semibold ${
                                inv.status === 'paid'
                                  ? 'bg-emerald-950/70 border-emerald-400/50 text-emerald-200'
                                  : inv.status === 'pending_approval'
                                    ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                                    : 'bg-bro-cyan/15 border-bro-cyan/45 text-bro-cyan'
                              }`}
                            >
                              {inv.status.replace(/_/g, ' ')}
                            </span>
                            <div className="font-mono text-xs text-slate-400 mt-1.5 tabular-nums">
                              Due {formatDateIso(inv.dueDate)}
                              {inv.paymentRef ? ` · ${inv.paymentRef}` : ''}
                            </div>
                          </td>
                          <td className="px-4 py-3.5 text-right whitespace-nowrap">
                            <div className="inline-flex flex-wrap justify-end gap-2">
                              {needsApproval && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleApproveInvoice(inv)}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                                  <span>Approve &amp; Assemble Packet</span>
                                </button>
                              )}
                              {inv.status !== 'paid' && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => {
                                    setPaymentRef('EFT/ACH-CLEARED');
                                    setRenderedPayInv(inv);
                                    setPayModalInv(inv);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-400/45 text-xs font-bold uppercase text-emerald-200 cursor-pointer disabled:opacity-50 transition-colors"
                                >
                                  <CreditCard className="w-3.5 h-3.5" aria-hidden="true" />
                                  <span>Mark Paid</span>
                                </button>
                              )}
                              <a
                                href={`/api/billing/invoices/${encodeURIComponent(inv.id)}/pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-[#0b1120] hover:bg-slate-800 border border-white/15 text-xs font-medium text-white transition-colors"
                              >
                                <FileText className="w-3.5 h-3.5 text-bro-cyan" aria-hidden="true" />
                                <span>Invoice PDF</span>
                              </a>
                              {hasFactoringPacket ? (
                                <a
                                  href={`/api/ops/billing/invoices/${encodeURIComponent(inv.id)}/factoring-packet.pdf`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl border bg-bro-gold/15 border-bro-gold/45 text-bro-gold hover:bg-bro-gold/25 text-xs font-bold transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                                  <span>Factoring Packet PDF</span>
                                </a>
                              ) : (
                                <button
                                  type="button"
                                  disabled
                                  title="Approve invoice first to generate and archive the Factoring Packet PDF"
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl border bg-white/[0.04] border-white/10 text-slate-400 text-xs font-medium cursor-not-allowed"
                                >
                                  <span>Approve for Factoring PDF</span>
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
        </div>
      )}

      {/* TAB B: DRIVER SETTLEMENTS */}
      {activeTab === 'settlements' && (
        <div
          role="tabpanel"
          id="billing-panel-settlements"
          aria-labelledby="billing-tab-settlements"
          className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start"
        >
          {/* Settlement Generator Form */}
          <section aria-label="Generate Driver Settlement Statement" className="xl:col-span-4 surface-ceramic rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2 border-b border-white/10 pb-3">
              <DollarSign className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base font-bold text-white">
                Generate Driver Settlement Statement
              </h2>
            </div>

            <form onSubmit={handleGenerateSettlement} className="space-y-4">
              <div>
                <label htmlFor="stl-driver" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Select Driver / Owner-Operator
                </label>
                <select
                  id="stl-driver"
                  required
                  value={selectedDriverId}
                  onChange={(e) => setSelectedDriverId(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
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
                <label htmlFor="stl-fuel" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Fleet Fuel Card Deduction ($ CAD)
                </label>
                <input
                  id="stl-fuel"
                  type="number"
                  step="0.01"
                  min="0"
                  value={fuelDeductionDollars}
                  onChange={(e) => setFuelDeductionDollars(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums outline-none"
                />
              </div>

              <div>
                <label htmlFor="stl-ins" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Occupational Insurance / Escrow Deduction ($ CAD)
                </label>
                <input
                  id="stl-ins"
                  type="number"
                  step="0.01"
                  min="0"
                  value={insuranceDeductionDollars}
                  onChange={(e) => setInsuranceDeductionDollars(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={settleBusy || !selectedDriverId}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-bro-gold text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-amber-400 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <FileText className="w-4 h-4" aria-hidden="true" />
                <span>{settleBusy ? 'Rendering PDF Statement...' : 'Generate Statement PDF'}</span>
              </button>
            </form>
          </section>

          {/* Settlements History */}
          <section aria-label="Driver Settlements Ledger" className="xl:col-span-8 surface-ceramic rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10">
              <h2 className="font-display text-base font-bold text-white">
                Finalized Driver Settlements ({settlements.length})
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                    <th className="px-4 py-3">Statement #</th>
                    <th className="px-4 py-3">Driver &amp; Period</th>
                    <th className="px-4 py-3 text-right">Gross Pay</th>
                    <th className="px-4 py-3 text-right">Deductions</th>
                    <th className="px-4 py-3 text-right">Net Pay</th>
                    <th className="px-4 py-3 text-right">PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs font-mono">
                  {settlements.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center font-sans text-slate-300">
                        No driver settlements generated yet. Select a driver to render a statement PDF.
                      </td>
                    </tr>
                  ) : (
                    settlements.map((stl) => {
                      const drv = driverMap.get(stl.driverId);
                      return (
                        <tr key={stl.id} className="hover:bg-white/[0.03]">
                          <td className="px-4 py-3.5 font-bold text-white whitespace-nowrap">{stl.settlementNumber}</td>
                          <td className="px-4 py-3.5">
                            <div className="font-sans text-sm font-medium text-slate-100">{drv?.fullName || stl.driverId}</div>
                            <div className="text-xs text-slate-400 tabular-nums mt-0.5">
                              {formatDateIso(stl.periodStart)} to {formatDateIso(stl.periodEnd)}
                            </div>
                          </td>
                          <td className="px-4 py-3.5 text-right tabular-nums text-slate-200 whitespace-nowrap">
                            {formatCents(stl.grossPayCents, stl.currency)}
                          </td>
                          <td className="px-4 py-3.5 text-right tabular-nums text-rose-200 whitespace-nowrap">
                            -{formatCents(stl.deductionsCents, stl.currency)}
                          </td>
                          <td className="px-4 py-3.5 text-right font-bold tabular-nums text-emerald-200 whitespace-nowrap">
                            {formatCents(stl.netPayCents, stl.currency)}
                          </td>
                          <td className="px-4 py-3.5 text-right whitespace-nowrap">
                            <a
                              href={`/api/settlements/${encodeURIComponent(stl.id)}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-[#0b1120] hover:bg-slate-800 border border-white/15 text-xs text-bro-cyan font-bold transition-colors"
                            >
                              <Download className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>PDF</span>
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
        <div
          role="tabpanel"
          id="billing-panel-ifta"
          aria-labelledby="billing-tab-ifta"
          className="space-y-6"
        >
          {/* Quarter Selector & CSV Export */}
          <div className="flex flex-wrap items-center justify-between gap-3 surface-ceramic rounded-2xl p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-300 mr-1">Filing Quarter:</span>
              {QUARTERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuarter(q)}
                  className={`px-3.5 py-2 min-h-[40px] rounded-full font-mono text-xs border cursor-pointer transition-colors ${
                    quarter === q
                      ? 'bg-white text-black border-white font-bold'
                      : 'bg-[#0b1120] border-white/10 text-slate-300 hover:text-white'
                  }`}
                >
                  {q}
                </button>
              ))}
              <span className="text-xs text-slate-300 ml-2 tabular-nums">
                ({iftaRawCount} fuel/mileage logs)
              </span>
            </div>

            <a
              href={`/api/ops/ifta/report.csv?quarter=${encodeURIComponent(quarter)}`}
              download={`BRO-IFTA-${quarter}.csv`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-bro-gold text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-amber-400 transition-colors"
            >
              <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />
              <span>Export IFTA CSV ({quarter})</span>
            </a>
          </div>

          {/* IFTA Summary KPIs */}
          {iftaReport && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="surface-ceramic rounded-2xl p-4 sm:p-5">
                <div className="text-xs font-medium text-slate-300">Total Fleet Miles</div>
                <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-white mt-2">
                  {iftaReport.totalMiles.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mi
                </div>
              </div>
              <div className="surface-ceramic rounded-2xl p-4 sm:p-5">
                <div className="text-xs font-medium text-slate-300">Tax-Paid Fuel Purchased</div>
                <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-bro-cyan mt-2">
                  {iftaReport.totalGallons.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} gal
                </div>
              </div>
              <div className="surface-ceramic rounded-2xl p-4 sm:p-5">
                <div className="text-xs font-medium text-slate-300">Fleet Average MPG</div>
                <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-white mt-2">
                  {iftaReport.fleetMpg.toFixed(2)} MPG
                </div>
              </div>
              <div className="surface-ceramic rounded-2xl p-4 sm:p-5 border border-bro-gold/35">
                <div className="text-xs font-medium text-slate-300">Net IFTA Tax Due / (Credit)</div>
                <div
                  className={`text-xl sm:text-2xl font-display font-bold tabular-nums mt-2 ${
                    iftaReport.totalNetTaxDueCents > 0 ? 'text-rose-200' : 'text-emerald-200'
                  }`}
                >
                  {formatCents(iftaReport.totalNetTaxDueCents, 'USD')}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            {/* Add Mileage / Fuel Log Form */}
            <section aria-label="Record IFTA Mileage and Fuel Log" className="xl:col-span-4 surface-ceramic rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                <Plus className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
                <h2 className="font-display text-base font-bold text-white">
                  Add Jurisdiction Log ({quarter})
                </h2>
              </div>

              <form onSubmit={handleAddIftaLog} className="space-y-3.5">
                <div>
                  <label htmlFor="ifta-tractor" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Tractor Unit
                  </label>
                  {tractors.length > 0 ? (
                    <select
                      id="ifta-tractor"
                      required
                      value={iftaForm.tractorId}
                      onChange={(e) => setIftaForm({ ...iftaForm, tractorId: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white outline-none"
                    >
                      {tractors.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.unitNumber} ({t.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="ifta-tractor"
                      type="text"
                      required
                      placeholder="e.g. eq_trc_101"
                      value={iftaForm.tractorId}
                      onChange={(e) => setIftaForm({ ...iftaForm, tractorId: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white placeholder:text-slate-400 outline-none"
                    />
                  )}
                </div>

                <div>
                  <label htmlFor="ifta-jurisdiction" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Jurisdiction (State / Province)
                  </label>
                  <select
                    id="ifta-jurisdiction"
                    value={iftaForm.jurisdictionCode}
                    onChange={(e) => setIftaForm({ ...iftaForm, jurisdictionCode: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white outline-none"
                  >
                    {IFTA_JURISDICTIONS.map((jur) => (
                      <option key={jur} value={jur}>
                        {jur} — ${(IFTA_DIESEL_RATE_CENTS_PER_GAL[jur] / 100).toFixed(2)} USD/gal
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="ifta-distance" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Distance (km)
                    </label>
                    <input
                      id="ifta-distance"
                      type="number"
                      min="0"
                      step="0.1"
                      required
                      value={iftaForm.distanceKm}
                      onChange={(e) => setIftaForm({ ...iftaForm, distanceKm: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="ifta-fuel-liters" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Fuel (Liters)
                    </label>
                    <input
                      id="ifta-fuel-liters"
                      type="number"
                      min="0"
                      step="0.1"
                      value={iftaForm.fuelLiters}
                      onChange={(e) => setIftaForm({ ...iftaForm, fuelLiters: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="ifta-fuel-cost" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Receipt Fuel Cost ($)
                  </label>
                  <input
                    id="ifta-fuel-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    value={iftaForm.fuelCostDollars}
                    onChange={(e) => setIftaForm({ ...iftaForm, fuelCostDollars: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={iftaBusy || !iftaForm.tractorId.trim()}
                  className="w-full px-4 py-2.5 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
                >
                  {iftaBusy ? 'Logging Entry...' : 'Record IFTA Entry'}
                </button>
              </form>
            </section>

            {/* Jurisdiction Breakdown Table */}
            <section aria-label="IFTA Jurisdiction Breakdown" className="xl:col-span-8 surface-ceramic rounded-2xl overflow-hidden">
              <div className="p-4 sm:p-5 border-b border-white/10">
                <h2 className="font-display text-base font-bold text-white">
                  Jurisdiction Breakdown — {quarter}
                </h2>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                      <th className="px-4 py-3">Jurisdiction</th>
                      <th className="px-4 py-3 text-right">Miles</th>
                      <th className="px-4 py-3 text-right">Taxable Gal</th>
                      <th className="px-4 py-3 text-right">Tax-Paid Gal</th>
                      <th className="px-4 py-3 text-right">Net Gal</th>
                      <th className="px-4 py-3 text-right">Rate ($/gal)</th>
                      <th className="px-4 py-3 text-right">Net Tax Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-xs font-mono tabular-nums">
                    {!iftaReport || iftaReport.jurisdictions.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center font-sans text-slate-300">
                          No IFTA jurisdiction logs recorded for {quarter}.
                        </td>
                      </tr>
                    ) : (
                      iftaReport.jurisdictions.map((j) => (
                        <tr key={j.jurisdictionCode} className="hover:bg-white/[0.03]">
                          <td className="px-4 py-3.5 font-bold text-white">{j.jurisdictionCode}</td>
                          <td className="px-4 py-3.5 text-right text-slate-200">{j.miles.toFixed(2)}</td>
                          <td className="px-4 py-3.5 text-right text-slate-300">{j.taxableGallons.toFixed(2)}</td>
                          <td className="px-4 py-3.5 text-right text-bro-cyan">{j.taxPaidGallons.toFixed(2)}</td>
                          <td className="px-4 py-3.5 text-right text-slate-200">{j.netTaxableGallons.toFixed(2)}</td>
                          <td className="px-4 py-3.5 text-right text-slate-300">
                            ${(j.taxRateCentsPerGal / 100).toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-3.5 text-right font-bold ${
                              j.netTaxDueCents > 0 ? 'text-rose-200' : 'text-emerald-200'
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
        <div
          role="tabpanel"
          id="billing-panel-pnl"
          aria-labelledby="billing-tab-pnl"
          className="space-y-6"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="surface-ceramic rounded-2xl p-4 sm:p-5 border border-bro-cyan/30">
              <div className="text-xs font-medium text-slate-300">Gross Customer Revenue</div>
              <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-white mt-2">
                {formatCentsShort(pnlTotals.revCents)}
              </div>
            </div>
            <div className="surface-ceramic rounded-2xl p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-300">Carrier / Driver Cost</div>
              <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-slate-200 mt-2">
                {formatCentsShort(pnlTotals.costCents)}
              </div>
            </div>
            <div className="surface-ceramic rounded-2xl p-4 sm:p-5 border border-emerald-400/35">
              <div className="text-xs font-medium text-slate-300">Net Gross Profit</div>
              <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-emerald-200 mt-2">
                {formatCentsShort(totalProfitCents)}
              </div>
            </div>
            <div className="surface-ceramic rounded-2xl p-4 sm:p-5 border border-bro-gold/35">
              <div className="text-xs font-medium text-slate-300">Blended Net Margin</div>
              <div className="text-xl sm:text-2xl font-display font-bold tabular-nums text-bro-gold mt-2">
                {blendedMarginPct}%
              </div>
            </div>
          </div>

          <section aria-label="Per-Load Profit and Loss Table" className="surface-ceramic rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10">
              <h2 className="font-display text-base font-bold text-white">
                Per-Load Revenue vs. Carrier/Driver Cost &amp; Net Margin ({loads.length} loads)
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                    <th className="px-4 py-3">Load # / Division</th>
                    <th className="px-4 py-3">Shipper</th>
                    <th className="px-4 py-3 text-right">Loaded Miles</th>
                    <th className="px-4 py-3 text-right">Customer Rev</th>
                    <th className="px-4 py-3 text-right">Carrier Cost</th>
                    <th className="px-4 py-3 text-right">Net Profit</th>
                    <th className="px-4 py-3 text-right">Margin %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs font-mono tabular-nums">
                  {loads.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center font-sans text-slate-300">
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
                            : 'bg-rose-950/70 text-rose-200 border-rose-400/50';
                      return (
                        <tr key={l.id} className="hover:bg-white/[0.03]">
                          <td className="px-4 py-3.5">
                            <div className="font-bold text-white">{l.loadNumber}</div>
                            <div className="text-xs text-slate-400 uppercase mt-0.5">
                              {l.equipmentType.replace(/_/g, ' ')} · {l.status}
                            </div>
                          </td>
                          <td className="px-4 py-3.5 font-sans text-sm text-slate-100">{org?.name || l.shipperOrgId}</td>
                          <td className="px-4 py-3.5 text-right text-slate-300">{l.loadedMiles.toLocaleString()} mi</td>
                          <td className="px-4 py-3.5 text-right text-white">
                            {formatCents(l.rateCustomerCents, l.currency)}
                          </td>
                          <td className="px-4 py-3.5 text-right text-slate-300">
                            {formatCents(l.rateCarrierCents, l.currency)}
                          </td>
                          <td
                            className={`px-4 py-3.5 text-right font-bold ${
                              profitCents >= 0 ? 'text-emerald-200' : 'text-rose-200'
                            }`}
                          >
                            {formatCents(profitCents, l.currency)}
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <span className={`px-2.5 py-1 rounded-full border text-xs font-bold ${marginBadge}`}>
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

      {/* Accessible Create Commercial Invoice Modal */}
      {createInvModal.mounted && (
        <div
          className="fixed inset-0 z-50 flex justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-invoice-title"
        >
          <div
            className="bro-modal-backdrop fixed inset-0 bg-black/75 backdrop-blur-sm"
            data-visible={createInvModal.visible ? 'true' : 'false'}
            onClick={closeCreateInvModal}
          />
          <div
            ref={createInvModal.containerRef}
            data-visible={createInvModal.visible ? 'true' : 'false'}
            className="bro-modal-panel relative z-10 w-full max-w-xl surface-ceramic rounded-2xl border border-bro-cyan/40 shadow-2xl overflow-hidden my-auto"
          >
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Receipt className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
                <h3 id="create-invoice-title" className="font-display text-base font-bold text-white">
                  Create Commercial Invoice
                </h3>
              </div>
              <button
                type="button"
                onClick={closeCreateInvModal}
                aria-label="Close create invoice modal"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateInvoiceSubmit} className="p-5 space-y-4">
              {createInvError && (
                <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-400/50 text-xs text-rose-200">
                  {createInvError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="inv-load-id" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Billable Load
                  </label>
                  <select
                    id="inv-load-id"
                    ref={createInvLoadRef}
                    required
                    value={createInvForm.loadId}
                    onChange={(e) => handleCreateInvoiceLoadChange(e.target.value)}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                  >
                    <option value="">-- Select Load --</option>
                    {loads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.loadNumber} — {l.commodity}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="inv-shipper-org" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Shipper Account
                  </label>
                  <select
                    id="inv-shipper-org"
                    required
                    value={createInvForm.shipperOrgId}
                    onChange={(e) => setCreateInvForm({ ...createInvForm, shipperOrgId: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                  >
                    <option value="">-- Select Shipper --</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({o.id})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="inv-direction" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Tax Jurisdiction / Corridor
                  </label>
                  <select
                    id="inv-direction"
                    value={createInvForm.direction}
                    onChange={(e) => setCreateInvForm({ ...createInvForm, direction: e.target.value as LoadDirection })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                  >
                    <option value="ca_to_us">CA → US (Zero-Rated 0%)</option>
                    <option value="us_to_ca">US → CA (Zero-Rated 0%)</option>
                    <option value="domestic_ca">Domestic Canada (HST/GST)</option>
                    <option value="domestic_us">Domestic US (Exempt 0%)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label htmlFor="inv-currency" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Currency
                    </label>
                    <select
                      id="inv-currency"
                      value={createInvForm.currency}
                      onChange={(e) => setCreateInvForm({ ...createInvForm, currency: e.target.value as 'CAD' | 'USD' })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white outline-none"
                    >
                      <option value="CAD">CAD</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="inv-due-days" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Net Terms (Days)
                    </label>
                    <input
                      id="inv-due-days"
                      type="number"
                      min="0"
                      max="90"
                      required
                      value={createInvForm.dueDays}
                      onChange={(e) => setCreateInvForm({ ...createInvForm, dueDays: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums outline-none"
                    />
                  </div>
                </div>

                {createInvForm.direction === 'domestic_ca' && (
                  <div>
                    <label htmlFor="inv-dest-province" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Destination Province (HST/GST)
                    </label>
                    <input
                      id="inv-dest-province"
                      type="text"
                      maxLength={2}
                      placeholder="PE"
                      value={createInvForm.destinationProvince}
                      onChange={(e) =>
                        setCreateInvForm({ ...createInvForm, destinationProvince: e.target.value.toUpperCase() })
                      }
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white uppercase outline-none"
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="inv-item-code" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Line Code
                  </label>
                  <input
                    id="inv-item-code"
                    type="text"
                    required
                    minLength={2}
                    value={createInvForm.itemCode}
                    onChange={(e) => setCreateInvForm({ ...createInvForm, itemCode: e.target.value.toUpperCase() })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white uppercase outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="inv-item-amount" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Linehaul Amount ($)
                  </label>
                  <input
                    id="inv-item-amount"
                    type="number"
                    step="0.01"
                    min="1"
                    required
                    placeholder="3850.00"
                    value={createInvForm.amountDollars}
                    onChange={(e) => setCreateInvForm({ ...createInvForm, amountDollars: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="inv-item-desc" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Line Item Description
                  </label>
                  <input
                    id="inv-item-desc"
                    type="text"
                    required
                    minLength={2}
                    placeholder="Commercial Freight Linehaul"
                    value={createInvForm.itemDescription}
                    onChange={(e) => setCreateInvForm({ ...createInvForm, itemDescription: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-2.5 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={closeCreateInvModal}
                  className="px-4 py-2 min-h-[44px] rounded-xl border border-white/15 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createInvBusy}
                  className="px-5 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
                >
                  {createInvBusy ? 'Creating Invoice...' : 'Create Invoice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Accessible Mark Paid Modal */}
      {payModal.mounted && renderedPayInv && (
        <div
          className="fixed inset-0 z-50 flex justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mark-paid-title"
        >
          <div
            className="bro-modal-backdrop fixed inset-0 bg-black/75 backdrop-blur-sm"
            data-visible={payModal.visible ? 'true' : 'false'}
            onClick={closePayModal}
          />
          <div
            ref={payModal.containerRef}
            data-visible={payModal.visible ? 'true' : 'false'}
            className="bro-modal-panel relative z-10 w-full max-w-md surface-ceramic rounded-2xl border border-emerald-400/40 shadow-2xl overflow-hidden my-auto"
          >
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
              <h3 id="mark-paid-title" className="font-display text-base font-bold text-white">
                Record Settlement Payment — {renderedPayInv.invoiceNumber}
              </h3>
              <button
                type="button"
                onClick={closePayModal}
                aria-label="Close payment modal"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleMarkPaidSubmit} className="p-5 space-y-4">
              <div className="p-3.5 rounded-xl bg-[#0b1120] border border-white/10 text-xs flex justify-between items-center">
                <span className="text-slate-300">Amount Settled:</span>
                <span className="font-mono font-bold text-emerald-200 tabular-nums text-sm">
                  {formatCents(renderedPayInv.totalCents, renderedPayInv.currency)}
                </span>
              </div>
              <div>
                <label htmlFor="payment-ref-input" className="block text-xs font-medium text-slate-300 mb-1.5">
                  EFT / ACH / Factoring Wire Reference
                </label>
                <input
                  id="payment-ref-input"
                  ref={payInputRef}
                  type="text"
                  required
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-emerald-400 px-3 py-2.5 min-h-[44px] font-mono text-xs text-white outline-none"
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2.5 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={closePayModal}
                  className="px-4 py-2 min-h-[44px] rounded-xl border border-white/15 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyInvoiceId === renderedPayInv.id}
                  className="px-5 py-2 min-h-[44px] rounded-xl bg-emerald-400 text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-emerald-300 cursor-pointer disabled:opacity-50 transition-colors"
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
