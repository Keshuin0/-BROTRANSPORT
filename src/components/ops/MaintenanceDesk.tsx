import { useState, useEffect, useCallback, useRef, type SyntheticEvent } from 'react';
import {
  CheckCircle2,
  Plus,
  RefreshCw,
  Sparkles,
  Truck,
  Wrench,
  X,
} from 'lucide-react';
import type { WorkOrderPriority, WorkOrderStatus } from '@bro/contracts';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

interface WorkOrderRow {
  id: string;
  equipmentId: string;
  dvirId: string | null;
  unitNumber: string;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  title: string;
  description: string;
  estimatedCostCents: number;
  actualCostCents: number | null;
  vendorName: string | null;
  assignedMechanic: string | null;
  clearedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EquipmentRow {
  id: string;
  unitNumber: string;
  type: 'tractor' | 'dry_van' | 'reefer' | 'flatbed';
  vin: string;
  plate: string;
  jurisdiction: string;
  operatingHours: number;
  annualInspectionExpiry: number;
  status: 'active' | 'maintenance' | 'out_of_service';
}

interface DvirRow {
  id: string;
  driverId: string;
  tractorId: string;
  trailerId: string | null;
  inspectionType: 'pre_trip' | 'post_trip';
  odometerKm: number;
  defectsFound: boolean;
  safeToOperate: boolean;
  driverSignatureName: string;
  signedAt: number;
  mechanicClearedBy: string | null;
  mechanicClearedAt: number | null;
}

const PRIORITY_BADGES: Record<WorkOrderPriority, string> = {
  low: 'bg-slate-800 text-slate-300 border-slate-600',
  medium: 'bg-sky-950/70 text-sky-200 border-sky-400/40',
  high: 'bg-bro-gold/15 text-bro-gold border-bro-gold/40',
  critical: 'bg-rose-950/80 text-rose-200 border-rose-500/50',
};

const STATUS_BADGES: Record<WorkOrderStatus, string> = {
  open: 'bg-bro-gold/15 text-bro-gold border-bro-gold/40',
  in_progress: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  awaiting_parts: 'bg-amber-950/70 text-amber-200 border-amber-400/40',
  completed: 'bg-emerald-950/70 text-emerald-200 border-emerald-400/40',
  cancelled: 'bg-slate-800 text-slate-400 border-slate-700',
};

function formatCents(cents: number | null | undefined): string {
  const val = ((cents ?? 0) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${val} CAD`;
}

export default function MaintenanceDesk() {
  const [workOrders, setWorkOrders] = useState<WorkOrderRow[]>([]);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [dvirs, setDvirs] = useState<DvirRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | WorkOrderStatus>('all');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Create Work Order Form State
  const [equipmentId, setEquipmentId] = useState('');
  const [priority, setPriority] = useState<WorkOrderPriority>('high');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [estCostDollars, setEstCostDollars] = useState('450');
  const [vendorName, setVendorName] = useState('Charlottetown Heavy Truck & Trailer Bay');
  const [assignedMechanic, setAssignedMechanic] = useState('Marc-André LeBlanc (Red Seal HET)');

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const { mounted, visible, containerRef } = useModalFocusTrap<HTMLDivElement, HTMLInputElement>({
    open: modalOpen,
    onClose: () => setModalOpen(false),
    initialFocusRef: titleInputRef,
  });

  const fetchMaintenance = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ops/maintenance');
      if (res.ok) {
        const data = (await res.json()) as {
          workOrders?: WorkOrderRow[];
          equipment?: EquipmentRow[];
          dvirInspections?: DvirRow[];
        };
        const eqList = Array.isArray(data.equipment) ? data.equipment : [];
        setWorkOrders(Array.isArray(data.workOrders) ? data.workOrders : []);
        setEquipment(eqList);
        setDvirs(Array.isArray(data.dvirInspections) ? data.dvirInspections : []);
        if (!equipmentId && eqList[0]) {
          setEquipmentId(eqList[0].id);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [equipmentId]);

  useEffect(() => {
    void fetchMaintenance();
    const onExecuted = () => void fetchMaintenance();
    window.addEventListener('bro:agent-action-executed', onExecuted);
    return () => window.removeEventListener('bro:agent-action-executed', onExecuted);
  }, [fetchMaintenance]);

  const handleCreateWorkOrder = async (e: SyntheticEvent) => {
    e.preventDefault();
    const unit = equipment.find((u) => u.id === equipmentId);
    if (!unit) return;

    setBusyId('create');
    setBanner(null);
    try {
      const estimatedCostCents = Math.max(0, Math.round(Number(estCostDollars || 0) * 100));
      const res = await fetch('/api/ops/maintenance/work-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          equipmentId: unit.id,
          unitNumber: unit.unitNumber,
          priority,
          title,
          description,
          estimatedCostCents,
          vendorName: vendorName.trim() || undefined,
          assignedMechanic: assignedMechanic.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { error?: string; id?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create work order.');
      }

      setModalOpen(false);
      setTitle('');
      setDescription('');
      setBanner({
        kind: 'success',
        text: `Opened Shop Work Order for ${unit.unitNumber}.`,
      });
      await fetchMaintenance();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to create work order.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleUpdateWorkOrderStatus = async (
    order: WorkOrderRow,
    nextStatus: WorkOrderStatus,
    clearOosLock = false,
  ) => {
    setBusyId(order.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/maintenance/work-orders/${order.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: nextStatus,
          actualCostCents: nextStatus === 'completed' ? order.estimatedCostCents : undefined,
          clearOosLock,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update work order.');
      }
      setBanner({
        kind: 'success',
        text:
          nextStatus === 'completed'
            ? `Completed work order for ${order.unitNumber} and restored unit to ACTIVE fleet service.`
            : `Updated ${order.unitNumber} work order to ${nextStatus.replace('_', ' ')}.`,
      });
      await fetchMaintenance();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Update failed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const openMaintenanceCopilot = () => {
    window.dispatchEvent(
      new CustomEvent('bro:open-copilot', {
        detail: {
          agentId: 'ShopMaintenanceAgent',
          prompt: 'Prioritize open shop work orders by safety criticality and RUL hours.',
        },
      }),
    );
  };

  const openOrders = workOrders.filter((w) => w.status !== 'completed' && w.status !== 'cancelled');
  const oosUnits = equipment.filter((e) => e.status === 'out_of_service' || e.status === 'maintenance');
  const openDvirDefects = dvirs.filter((d) => d.defectsFound && !d.mechanicClearedAt);
  const totalEstSpendCents = openOrders.reduce((s, w) => s + w.estimatedCostCents, 0);

  const visibleOrders =
    statusFilter === 'all' ? workOrders : workOrders.filter((w) => w.status === statusFilter);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="surface-ceramic p-5 sm:p-6 rounded-2xl border border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-bro-cyan">
            <Wrench className="w-4 h-4" />
            <span>Fleet Engineering · Preventive Maintenance, DVIR Bay &amp; OOS Release</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-white">
            Shop Maintenance &amp; Work Order Command Desk
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
            Manage preventive CVIP renewals, Weibull-Cox predictive maintenance alerts, and mandatory mechanic sign-off before releasing Out-of-Service equipment locks.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openMaintenanceCopilot}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border border-bro-cyan/40 bg-bro-cyan/15 hover:bg-bro-cyan/25 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>Ask Shop Maintenance Agent</span>
          </button>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full bg-bro-gold hover:bg-amber-400 text-xs font-semibold text-black cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>New Work Order</span>
          </button>
          <button
            type="button"
            onClick={() => void fetchMaintenance()}
            className="min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-white/15 bg-white/[0.04] hover:bg-white/10 text-xs text-slate-200 cursor-pointer transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
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
          <div className="text-xs text-slate-400">Open Shop Work Orders</div>
          <div className="font-display text-2xl font-bold text-white">{openOrders.length}</div>
          <div className="text-[11px] text-slate-400">Active bay &amp; vendor queue</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Units in Shop / OOS Lock</div>
          <div className="font-display text-2xl font-bold text-rose-400">{oosUnits.length}</div>
          <div className="text-[11px] text-slate-400">Blocked from dispatch assignment</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Un-Cleared DVIR Defects</div>
          <div className="font-display text-2xl font-bold text-bro-gold">{openDvirDefects.length}</div>
          <div className="text-[11px] text-slate-400">Awaiting Red Seal mechanic clearance</div>
        </div>
        <div className="surface-ceramic p-4 rounded-2xl border border-white/10 space-y-1">
          <div className="text-xs text-slate-400">Projected Open Maintenance Spend</div>
          <div className="font-display text-2xl font-bold text-bro-cyan">
            {formatCents(totalEstSpendCents)}
          </div>
          <div className="text-[11px] text-slate-400">Integer-cent shop cost estimate</div>
        </div>
      </div>

      {/* Filter Bar & Work Orders Table */}
      <div className="surface-ceramic p-5 rounded-2xl border border-white/10 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
            <Truck className="w-4 h-4 text-bro-cyan" />
            <span>Active &amp; Historical Shop Work Orders ({visibleOrders.length})</span>
          </h2>

          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', 'open', 'in_progress', 'awaiting_parts', 'completed'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`min-h-[38px] px-3 py-1.5 rounded-full text-xs font-medium capitalize cursor-pointer transition-colors ${
                  statusFilter === st
                    ? 'bg-white text-black font-semibold'
                    : 'bg-white/[0.04] text-slate-300 border border-white/10 hover:bg-white/10'
                }`}
              >
                {st.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {visibleOrders.length === 0 ? (
          <div className="p-8 rounded-xl border border-white/10 bg-slate-950/60 text-xs text-slate-400 text-center">
            No shop work orders match this filter. Click &ldquo;New Work Order&rdquo; or run the Shop Maintenance Agent to generate preventive service orders.
          </div>
        ) : (
          <div className="space-y-3">
            {visibleOrders.map((wo) => {
              const isBusy = busyId === wo.id;
              return (
                <div
                  key={wo.id}
                  className="p-4 rounded-2xl border border-white/10 bg-slate-950/80 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-bold text-white px-2.5 py-0.5 rounded-md bg-white/10">
                        {wo.unitNumber}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full border text-[11px] font-mono uppercase ${
                          PRIORITY_BADGES[wo.priority]
                        }`}
                      >
                        {wo.priority}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full border text-[11px] font-mono uppercase ${
                          STATUS_BADGES[wo.status]
                        }`}
                      >
                        {wo.status.replace('_', ' ')}
                      </span>
                      <span className="font-mono text-xs text-bro-cyan">
                        Est: {formatCents(wo.estimatedCostCents)}
                      </span>
                    </div>
                    <h3 className="font-display text-sm sm:text-base font-semibold text-white">
                      {wo.title}
                    </h3>
                    <p className="text-xs text-slate-300 max-w-3xl">{wo.description}</p>
                    <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-400 pt-1">
                      <span>Bay / Vendor: {wo.vendorName ?? 'Internal Terminal Shop'}</span>
                      <span>Mechanic: {wo.assignedMechanic ?? 'Unassigned'}</span>
                      {wo.dvirId && <span className="text-bro-gold">Linked DVIR: {wo.dvirId}</span>}
                    </div>
                  </div>

                  {wo.status !== 'completed' && wo.status !== 'cancelled' && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {wo.status === 'open' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleUpdateWorkOrderStatus(wo, 'in_progress')}
                          className="min-h-[44px] px-3.5 py-2 rounded-xl border border-bro-cyan/40 bg-bro-cyan/10 hover:bg-bro-cyan/20 text-xs font-semibold text-bro-cyan cursor-pointer transition-colors"
                        >
                          Start Bay Work
                        </button>
                      )}
                      {wo.status !== 'awaiting_parts' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleUpdateWorkOrderStatus(wo, 'awaiting_parts')}
                          className="min-h-[44px] px-3.5 py-2 rounded-xl border border-white/15 bg-white/[0.04] hover:bg-white/10 text-xs text-slate-200 cursor-pointer transition-colors"
                        >
                          Awaiting Parts
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleUpdateWorkOrderStatus(wo, 'completed', true)}
                        className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-xs font-semibold text-black cursor-pointer transition-colors"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Complete &amp; Release OOS Lock</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* New Work Order Modal */}
      {mounted && (
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Create Shop Work Order"
          className="fixed inset-0 z-[110] flex items-center justify-center p-4"
        >
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm bro-modal-backdrop"
            data-visible={visible ? 'true' : 'false'}
            onClick={() => setModalOpen(false)}
            aria-hidden="true"
          />
          <form
            onSubmit={handleCreateWorkOrder}
            className="relative z-10 w-full max-w-lg rounded-2xl bg-slate-950 border border-white/15 p-6 space-y-4 shadow-2xl bro-modal-panel"
            data-visible={visible ? 'true' : 'false'}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-white">
                Open Shop Maintenance Work Order
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close modal"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full border border-white/15 text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="wo-equip" className="block text-xs text-slate-300">
                  Equipment Unit
                </label>
                <select
                  id="wo-equip"
                  value={equipmentId}
                  onChange={(e) => setEquipmentId(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white"
                >
                  {equipment.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.unitNumber} ({u.type.replace('_', ' ')} · {u.status})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="wo-priority" className="block text-xs text-slate-300">
                  Safety Priority
                </label>
                <select
                  id="wo-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as WorkOrderPriority)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white"
                >
                  <option value="low">Low (Routine PM)</option>
                  <option value="medium">Medium (Scheduled Service)</option>
                  <option value="high">High (Pre-Dispatch Fix)</option>
                  <option value="critical">Critical (Hold Unit in Shop)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="wo-title" className="block text-xs text-slate-300">
                Work Order Title
              </label>
              <input
                ref={titleInputRef}
                id="wo-title"
                type="text"
                required
                minLength={3}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Steer Axle Brake Chamber & Air Line Replacement"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="wo-desc" className="block text-xs text-slate-300">
                Technical Defect &amp; Repair Scope
              </label>
              <textarea
                id="wo-desc"
                required
                minLength={5}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe DVIR defect, Weibull sensor telemetry reading, or required OEM parts..."
                className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label htmlFor="wo-cost" className="block text-xs text-slate-300">
                  Est. Cost ($ CAD)
                </label>
                <input
                  id="wo-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  value={estCostDollars}
                  onChange={(e) => setEstCostDollars(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white font-mono"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="wo-vendor" className="block text-xs text-slate-300">
                  Shop / Vendor
                </label>
                <input
                  id="wo-vendor"
                  type="text"
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="wo-mech" className="block text-xs text-slate-300">
                  Assigned Mechanic
                </label>
                <input
                  id="wo-mech"
                  type="text"
                  value={assignedMechanic}
                  onChange={(e) => setAssignedMechanic(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 border border-white/15 text-xs text-white"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[44px] px-4 rounded-xl border border-white/15 text-xs text-slate-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyId === 'create'}
                className="min-h-[44px] px-5 rounded-xl bg-bro-gold hover:bg-amber-400 text-black font-semibold text-xs cursor-pointer transition-colors"
              >
                {busyId === 'create' ? 'Opening Order...' : 'Create Work Order'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
