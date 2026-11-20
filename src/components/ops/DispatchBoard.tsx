import { useState, useEffect, useCallback, useRef, type SyntheticEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Code2,
  Columns3,
  FileCode2,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Table as TableIcon,
  Truck,
  UserCheck,
  X,
} from 'lucide-react';
import {
  ALLOWED_STATUS_TRANSITIONS,
  LoadStatusSchema,
  type EquipmentType,
  type LoadDirection,
  type LoadStatus,
  type ParsedEdi204,
} from '@bro/contracts';
import { BroWsClient } from '../../lib/wsClient';

interface LoadRow {
  id: string;
  loadNumber: string;
  shipperOrgId: string;
  assignedDriverId: string | null;
  tractorId: string | null;
  trailerId: string | null;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  status: LoadStatus;
  commodity: string;
  weightLbs: number;
  loadedMiles: number;
  tempSetpointC: number | null;
  isFoodFda: boolean;
  rateCustomerCents: number;
  rateCarrierCents: number;
  currency: 'CAD' | 'USD';
  updatedAt: number;
}

interface DriverRow {
  id: string;
  fullName: string;
  equipmentDivision: EquipmentType;
  status: string;
  fastCardNumber: string | null;
}

interface EquipmentRow {
  id: string;
  unitNumber: string;
  type: 'tractor' | 'dry_van' | 'reefer' | 'flatbed';
  plate: string;
  jurisdiction: string;
  status: 'active' | 'maintenance' | 'out_of_service';
}

interface EdiMessageRow {
  id: string;
  loadId: string | null;
  transactionSet: '204' | '990' | '214' | '210' | '997';
  direction: 'inbound' | 'outbound';
  controlNumber: string;
  rawX12: string;
  parsedJson: string | null;
  status: string;
  ack997Received: boolean;
  createdAt: number;
}

interface InboundEdiResult {
  loadId: string;
  loadNumber: string;
  parsed: ParsedEdi204;
  ack997: string;
}

const ALL_STATES: readonly LoadStatus[] = LoadStatusSchema.options;

const SAMPLE_X12_204 = `ISA*00*          *00*          *02*CAVENDISHEDI   *02*BROP           *261120*1400*U*00401*000004821*0*P*:~
GS*SM*CAVENDISHEDI*BROP*20261120*1400*4821*X*004010~
ST*204*4821~
B2**BROP**BROP-EDI-4821**PP~
B2A*00*LT~
S5*1*CL~
N1*SH*CAVENDISH VALLEY COLD STORAGE~
N4*SUMMERSIDE*PE*C1N4J8*CA~
S5*2*UL~
N1*CN*NEW ENGLAND FRESH MARKET HUB~
N4*BOSTON*MA*02210*US~
L3*38400*G***3650.00~
SE*11*4821~
GE*1*4821~
IEA*1*000004821~`;

const STATUS_BADGE: Record<LoadStatus, string> = {
  QUOTED: 'bg-slate-800 text-slate-300 border-slate-600',
  BOOKED: 'bg-sky-950/70 text-sky-300 border-sky-500/40',
  DISPATCHED: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  AT_PICKUP: 'bg-indigo-950/70 text-indigo-300 border-indigo-500/40',
  IN_TRANSIT: 'bg-bro-cyan/20 text-bro-cyan border-bro-cyan/50',
  AT_BORDER: 'bg-bro-gold/15 text-bro-gold border-bro-gold/45',
  CLEARED: 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40',
  AT_DELIVERY: 'bg-teal-950/70 text-teal-300 border-teal-500/40',
  DELIVERED: 'bg-emerald-950/70 text-emerald-200 border-emerald-500/50',
  INVOICED: 'bg-violet-950/70 text-violet-300 border-violet-500/40',
  PAID: 'bg-emerald-900/70 text-emerald-100 border-emerald-400/60',
};

function formatCents(cents: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  const formatted = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}$${formatted} ${currency}`;
}

export default function DispatchBoard() {
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [ediMessages, setEdiMessages] = useState<EdiMessageRow[]>([]);

  const [viewMode, setViewMode] = useState<'table' | 'kanban'>('table');
  const [statusFilter, setStatusFilter] = useState<LoadStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyLoadId, setBusyLoadId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Assignment modal state
  const [assignModalLoad, setAssignModalLoad] = useState<LoadRow | null>(null);
  const [assignDriverId, setAssignDriverId] = useState('');
  const [assignTractorId, setAssignTractorId] = useState('');
  const [assignTrailerId, setAssignTrailerId] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const assignFocusRef = useRef<HTMLSelectElement | null>(null);

  // Create New Load modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createFocusRef = useRef<HTMLInputElement | null>(null);
  const [newLoadForm, setNewLoadForm] = useState({
    shipperOrgId: 'org_cavendish_produce',
    equipmentType: 'reefer' as EquipmentType,
    direction: 'ca_to_us' as LoadDirection,
    commodity: 'Chilled PEI Potatoes & Fresh Produce',
    weightLbs: 38000,
    rateCustomerDollars: '3850.00',
    rateCarrierDollars: '2350.00',
    currency: 'CAD' as 'CAD' | 'USD',
    isFoodFda: true,
    tempSetpointC: '4.0',
    pickupFacility: 'Cavendish Valley Cold Storage',
    pickupAddress: '100 Harvest Rd, Summerside, PE',
    pickupLat: '46.3959',
    pickupLon: '-63.7876',
    deliveryFacility: 'New England Fresh Market Hub',
    deliveryAddress: '45 Terminal Way, Boston, MA',
    deliveryLat: '42.3601',
    deliveryLon: '-71.0589',
  });

  // ANSI X12 EDI Panel state
  const [ediOpen, setEdiOpen] = useState(true);
  const [x12Input, setX12Input] = useState(SAMPLE_X12_204);
  const [ediBusy, setEdiBusy] = useState(false);
  const [ediError, setEdiError] = useState<string | null>(null);
  const [inboundResult, setInboundResult] = useState<InboundEdiResult | null>(null);
  const [outboundX12Preview, setOutboundX12Preview] = useState<{ label: string; rawX12: string } | null>(null);
  const [edi214Code, setEdi214Code] = useState<'X3' | 'AF' | 'X1' | 'D1' | 'AG'>('AF');
  const [edi214City, setEdi214City] = useState('CALAIS');
  const [edi214State, setEdi214State] = useState('ME');
  const [selectedEdiMsgId, setSelectedEdiMsgId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [loadsRes, ediRes] = await Promise.all([
        fetch('/api/ops/loads'),
        fetch('/api/ops/edi/messages'),
      ]);

      if (loadsRes.ok) {
        const data = (await loadsRes.json()) as {
          loads: LoadRow[];
          drivers: DriverRow[];
          equipment: EquipmentRow[];
        };
        setLoads(data.loads || []);
        setDrivers(data.drivers || []);
        setEquipment(data.equipment || []);
      } else {
        const err = (await loadsRes.json().catch(() => ({}))) as { error?: string };
        setBanner({ kind: 'error', text: err.error || `Unable to fetch dispatch board (HTTP ${loadsRes.status}).` });
      }

      if (ediRes.ok) {
        const ediData = (await ediRes.json()) as { messages: EdiMessageRow[] };
        setEdiMessages(ediData.messages || []);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error fetching loads and EDI messages.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Live OpsHub WS subscription with mandatory disconnect cleanup
  useEffect(() => {
    const client = new BroWsClient('ops:all', (msg) => {
      if (
        msg.type === 'LOAD_STATUS_CHANGED' ||
        msg.type === 'EDI_TENDER_RECEIVED' ||
        msg.type === 'RNS_CLEARED'
      ) {
        void fetchAll();
      }
    });
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [fetchAll]);

  // Escape key & focus management for accessible modals
  useEffect(() => {
    if (assignModalLoad) {
      assignFocusRef.current?.focus();
    }
    if (createOpen) {
      createFocusRef.current?.focus();
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (assignModalLoad) setAssignModalLoad(null);
        if (createOpen) setCreateOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [assignModalLoad, createOpen]);

  const openAssignModal = (load: LoadRow) => {
    setAssignModalLoad(load);
    setAssignDriverId(load.assignedDriverId || '');
    setAssignTractorId(load.tractorId || '');
    setAssignTrailerId(load.trailerId || '');
    setAssignError(null);
  };

  const handleAssignSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!assignModalLoad) return;
    setAssignBusy(true);
    setAssignError(null);
    try {
      const res = await fetch(`/api/ops/loads/${encodeURIComponent(assignModalLoad.id)}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedDriverId: assignDriverId || undefined,
          tractorId: assignTractorId || undefined,
          trailerId: assignTrailerId || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setAssignError(data.error || `Assignment failed (HTTP ${res.status}).`);
      } else {
        setBanner({
          kind: 'success',
          text: `Load ${assignModalLoad.loadNumber} assigned and transitioned to DISPATCHED.`,
        });
        setAssignModalLoad(null);
        await fetchAll();
      }
    } catch {
      setAssignError('Network error submitting asset assignment.');
    } finally {
      setAssignBusy(false);
    }
  };

  const handleAdvanceStatus = async (load: LoadRow, nextStatus: LoadStatus) => {
    setBusyLoadId(load.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/ops/loads/${encodeURIComponent(load.id)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ kind: 'error', text: data.error || 'Status transition rejected.' });
      } else {
        setBanner({
          kind: 'success',
          text: `${load.loadNumber} advanced to ${nextStatus} (Outbound X12 214 generated).`,
        });
        await fetchAll();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error updating load status.' });
    } finally {
      setBusyLoadId(null);
    }
  };

  const handleCreateLoad = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);

    const rateCustomerCents = Math.round(Number(newLoadForm.rateCustomerDollars) * 100);
    const rateCarrierCents = Math.round(Number(newLoadForm.rateCarrierDollars) * 100);
    if (!Number.isFinite(rateCustomerCents) || rateCustomerCents < 1000) {
      setCreateError('Customer rate must be at least $10.00.');
      setCreateBusy(false);
      return;
    }

    const now = Date.now();
    const payload = {
      shipperOrgId: newLoadForm.shipperOrgId.trim(),
      equipmentType: newLoadForm.equipmentType,
      direction: newLoadForm.direction,
      commodity: newLoadForm.commodity.trim(),
      weightLbs: Math.max(1, Math.min(45000, Math.round(Number(newLoadForm.weightLbs)))),
      rateCustomerCents,
      rateCarrierCents: Math.max(0, Number.isFinite(rateCarrierCents) ? rateCarrierCents : 0),
      currency: newLoadForm.currency,
      isFoodFda: newLoadForm.isFoodFda,
      tempSetpointC:
        newLoadForm.equipmentType === 'reefer' && newLoadForm.tempSetpointC !== ''
          ? Number(newLoadForm.tempSetpointC)
          : undefined,
      stops: [
        {
          seq: 1,
          stopType: 'pickup' as const,
          facilityName: newLoadForm.pickupFacility.trim(),
          address: newLoadForm.pickupAddress.trim(),
          lat: Number(newLoadForm.pickupLat) || 46.3959,
          lon: Number(newLoadForm.pickupLon) || -63.7876,
          apptStart: now + 4 * 3600_000,
          apptEnd: now + 6 * 3600_000,
        },
        {
          seq: 2,
          stopType: 'delivery' as const,
          facilityName: newLoadForm.deliveryFacility.trim(),
          address: newLoadForm.deliveryAddress.trim(),
          lat: Number(newLoadForm.deliveryLat) || 42.3601,
          lon: Number(newLoadForm.deliveryLon) || -71.0589,
          apptStart: now + 20 * 3600_000,
          apptEnd: now + 22 * 3600_000,
        },
      ],
    };

    try {
      const res = await fetch('/api/ops/loads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; loadNumber?: string };
      if (!res.ok) {
        setCreateError(data.error || `Failed to create load (HTTP ${res.status}).`);
      } else {
        setBanner({ kind: 'success', text: `Created load ${data.loadNumber} in BOOKED state.` });
        setCreateOpen(false);
        await fetchAll();
      }
    } catch {
      setCreateError('Network error creating new load.');
    } finally {
      setCreateBusy(false);
    }
  };

  const handleIngestEdi204 = async () => {
    if (!x12Input.trim()) return;
    setEdiBusy(true);
    setEdiError(null);
    setOutboundX12Preview(null);
    try {
      const res = await fetch('/api/edi/inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: x12Input,
      });
      const data = (await res.json().catch(() => ({}))) as Partial<InboundEdiResult> & { error?: string };
      if (!res.ok || !data.loadId || !data.parsed || !data.ack997) {
        setEdiError(data.error || `X12 204 ingestion failed (HTTP ${res.status}).`);
      } else {
        setInboundResult({
          loadId: data.loadId,
          loadNumber: data.loadNumber || data.parsed.shipmentId,
          parsed: data.parsed,
          ack997: data.ack997,
        });
        setBanner({
          kind: 'success',
          text: `Ingested X12 204 Tender -> Created Load ${data.loadNumber} & transmitted 997 Functional Ack.`,
        });
        await fetchAll();
      }
    } catch {
      setEdiError('Network error transmitting X12 204 payload.');
    } finally {
      setEdiBusy(false);
    }
  };

  const handleSend990 = async (loadId: string, action: 'A' | 'D') => {
    setEdiBusy(true);
    setEdiError(null);
    try {
      const res = await fetch(`/api/ops/edi/990/${encodeURIComponent(loadId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; rawX12?: string };
      if (!res.ok || !data.rawX12) {
        setEdiError(data.error || 'Failed to generate X12 990 response.');
      } else {
        setOutboundX12Preview({
          label: `Outbound X12 990 (${action === 'A' ? 'ACCEPTED -> BOOKED' : 'DECLINED'})`,
          rawX12: data.rawX12,
        });
        setBanner({
          kind: 'success',
          text: `Transmitted X12 990 (${action === 'A' ? 'Accept' : 'Decline'}) for load ${loadId}.`,
        });
        await fetchAll();
      }
    } catch {
      setEdiError('Network error sending X12 990.');
    } finally {
      setEdiBusy(false);
    }
  };

  const handleSend214 = async (loadId: string) => {
    setEdiBusy(true);
    setEdiError(null);
    try {
      const res = await fetch(`/api/ops/edi/214/${encodeURIComponent(loadId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statusCode: edi214Code,
          city: edi214City.trim().toUpperCase() || 'CALAIS',
          stateProv: edi214State.trim().toUpperCase() || 'ME',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; rawX12?: string };
      if (!res.ok || !data.rawX12) {
        setEdiError(data.error || 'Failed to transmit X12 214 status update.');
      } else {
        setOutboundX12Preview({
          label: `Outbound X12 214 Status (${edi214Code} @ ${edi214City}, ${edi214State})`,
          rawX12: data.rawX12,
        });
        setBanner({ kind: 'success', text: `Transmitted X12 214 (${edi214Code}) shipment status.` });
        await fetchAll();
      }
    } catch {
      setEdiError('Network error sending X12 214.');
    } finally {
      setEdiBusy(false);
    }
  };

  const driverMap = new Map(drivers.map((d) => [d.id, d]));
  const equipMap = new Map(equipment.map((eq) => [eq.id, eq]));
  const tractors = equipment.filter((e) => e.type === 'tractor');
  const trailers = equipment.filter((e) => e.type !== 'tractor');

  const filteredLoads = loads.filter((l) => {
    if (statusFilter !== 'ALL' && l.status !== statusFilter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      l.loadNumber.toLowerCase().includes(q) ||
      l.commodity.toLowerCase().includes(q) ||
      l.equipmentType.toLowerCase().includes(q) ||
      l.shipperOrgId.toLowerCase().includes(q)
    );
  });

  const selectedEdiMsg = ediMessages.find((m) => m.id === selectedEdiMsgId) || null;

  return (
    <div className="space-y-6">
      {/* Top Action Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-cyan">
            MODULE 01 // 11-STATE COMMERCIAL TMS & ANSI X12 EDI GATEWAY
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            Dispatch Board &amp; EDI Engine
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded border border-white/15 bg-bro-obsidian p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs cursor-pointer ${
                viewMode === 'table' ? 'bg-bro-cyan/20 text-bro-cyan font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" />
              Table
            </button>
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs cursor-pointer ${
                viewMode === 'kanban' ? 'bg-bro-cyan/20 text-bro-cyan font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Columns3 className="w-3.5 h-3.5" />
              11-State Kanban
            </button>
          </div>

          <button
            type="button"
            onClick={() => setEdiOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border font-mono text-xs cursor-pointer transition-colors ${
              ediOpen
                ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold font-bold'
                : 'bg-bro-steel border-white/15 text-slate-300 hover:text-white'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            X12 EDI Panel ({ediMessages.length})
          </button>

          <button
            type="button"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Load
          </button>

          <button
            type="button"
            onClick={() => void fetchAll()}
            aria-label="Refresh loads"
            className="p-2 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 text-slate-300 hover:text-white cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
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

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by load #, commodity, equipment, shipper..."
            className="w-full pl-9 pr-3 py-2 rounded bg-bro-steel/70 border border-white/10 focus:border-bro-cyan text-xs font-mono text-white placeholder-slate-500 outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={`px-2.5 py-1 rounded font-mono text-[10px] uppercase whitespace-nowrap border cursor-pointer ${
              statusFilter === 'ALL'
                ? 'bg-bro-cyan/20 border-bro-cyan/40 text-bro-cyan font-bold'
                : 'bg-bro-obsidian/70 border-white/10 text-slate-400 hover:text-white'
            }`}
          >
            ALL ({loads.length})
          </button>
          {ALL_STATES.map((st) => {
            const count = loads.filter((l) => l.status === st).length;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2 py-1 rounded font-mono text-[10px] uppercase whitespace-nowrap border cursor-pointer ${
                  statusFilter === st
                    ? 'bg-bro-gold/20 border-bro-gold/50 text-bro-gold font-bold'
                    : 'bg-bro-obsidian/70 border-white/10 text-slate-400 hover:text-white'
                }`}
              >
                {st} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Table or 11-State Kanban View */}
      {viewMode === 'table' ? (
        <section aria-label="Load Lifecycle Table" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 bg-bro-obsidian/60 font-mono text-[10px] uppercase text-slate-400">
                  <th className="px-4 py-3">Load # / Corridor</th>
                  <th className="px-4 py-3">Freight &amp; Division</th>
                  <th className="px-4 py-3">Assigned Assets</th>
                  <th className="px-4 py-3 text-right">Customer / Carrier</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Dispatch Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {filteredLoads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center font-mono text-slate-500">
                      {loading ? 'Loading 11-state TMS loads...' : 'No loads match the current filter.'}
                    </td>
                  </tr>
                ) : (
                  filteredLoads.map((load) => {
                    const drv = load.assignedDriverId ? driverMap.get(load.assignedDriverId) : null;
                    const trc = load.tractorId ? equipMap.get(load.tractorId) : null;
                    const trl = load.trailerId ? equipMap.get(load.trailerId) : null;
                    const nextStates = ALLOWED_STATUS_TRANSITIONS[load.status] || [];
                    const isBusy = busyLoadId === load.id;
                    return (
                      <tr key={load.id} className="hover:bg-white/5">
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <div className="font-mono font-bold text-white">{load.loadNumber}</div>
                          <div className="font-mono text-[10px] text-slate-400 uppercase mt-0.5">
                            {load.direction.replace(/_/g, ' ')} · {load.shipperOrgId}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="text-slate-100 font-medium">{load.commodity}</div>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono text-[10px]">
                            <span className="px-1.5 py-0.5 rounded bg-bro-steel border border-white/10 uppercase text-bro-cyan">
                              {load.equipmentType.replace(/_/g, ' ')}
                            </span>
                            <span className="text-slate-400 tabular-nums">
                              {load.weightLbs.toLocaleString()} lbs
                            </span>
                            {load.tempSetpointC !== null && (
                              <span className="text-sky-300 tabular-nums">{load.tempSetpointC.toFixed(1)}°C</span>
                            )}
                            {load.isFoodFda && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-300 border border-amber-500/30">
                                FDA 2-HR
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top font-mono text-[11px] whitespace-nowrap">
                          <div className="text-slate-200">{drv ? drv.fullName : <span className="text-slate-500">Unassigned Driver</span>}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {trc ? trc.unitNumber : 'No Tractor'} / {trl ? trl.unitNumber : 'No Trailer'}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top text-right font-mono whitespace-nowrap tabular-nums">
                          <div className="text-white font-semibold">{formatCents(load.rateCustomerCents, load.currency)}</div>
                          <div className="text-[10px] text-slate-400">
                            Cost: {formatCents(load.rateCarrierCents, load.currency)}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold ${STATUS_BADGE[load.status]}`}>
                            {load.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                          <div className="inline-flex flex-wrap justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => openAssignModal(load)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-bro-steel hover:bg-slate-800 border border-white/15 font-mono text-[10px] text-white cursor-pointer"
                            >
                              <UserCheck className="w-3 h-3 text-bro-cyan" />
                              Assign
                            </button>
                            {nextStates.map((ns) => (
                              <button
                                key={ns}
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleAdvanceStatus(load, ns)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-bro-cyan/15 hover:bg-bro-cyan/25 border border-bro-cyan/40 font-mono text-[10px] text-bro-cyan font-bold cursor-pointer disabled:opacity-50"
                              >
                                <ArrowRight className="w-3 h-3" />
                                {ns}
                              </button>
                            ))}
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
      ) : (
        <section aria-label="11-State Load Kanban" className="overflow-x-auto pb-3">
          <div className="flex gap-3 min-w-max">
            {ALL_STATES.map((stage) => {
              const colLoads = filteredLoads.filter((l) => l.status === stage);
              return (
                <div
                  key={stage}
                  className="w-64 shrink-0 glass-panel rounded-lg border border-white/10 flex flex-col max-h-[540px]"
                >
                  <div className="px-3 py-2.5 border-b border-white/10 flex items-center justify-between bg-bro-obsidian/70">
                    <span className="font-mono text-[10px] font-bold uppercase text-white">{stage}</span>
                    <span className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px] tabular-nums text-bro-cyan">
                      {colLoads.length}
                    </span>
                  </div>
                  <div className="p-2.5 space-y-2.5 overflow-y-auto flex-1">
                    {colLoads.length === 0 ? (
                      <div className="py-8 text-center font-mono text-[10px] text-slate-600">Empty stage</div>
                    ) : (
                      colLoads.map((load) => {
                        const drv = load.assignedDriverId ? driverMap.get(load.assignedDriverId) : null;
                        const nextStates = ALLOWED_STATUS_TRANSITIONS[load.status] || [];
                        return (
                          <div
                            key={load.id}
                            className="p-3 rounded bg-bro-obsidian/80 border border-white/10 space-y-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs font-bold text-white">{load.loadNumber}</span>
                              <span className="font-mono text-[10px] uppercase text-bro-gold">
                                {load.equipmentType.replace(/_/g, ' ')}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-300 line-clamp-2">{load.commodity}</p>
                            <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                              <span className="truncate">{drv ? drv.fullName : 'Unassigned'}</span>
                              <span className="text-white tabular-nums">
                                {formatCents(load.rateCustomerCents, load.currency)}
                              </span>
                            </div>
                            <div className="pt-1.5 border-t border-white/10 flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => openAssignModal(load)}
                                className="px-2 py-1 rounded bg-bro-steel border border-white/15 font-mono text-[10px] text-slate-200 hover:text-white cursor-pointer"
                              >
                                Assign
                              </button>
                              {nextStates.map((ns) => (
                                <button
                                  key={ns}
                                  type="button"
                                  disabled={busyLoadId === load.id}
                                  onClick={() => void handleAdvanceStatus(load, ns)}
                                  className="px-2 py-1 rounded bg-bro-cyan/15 border border-bro-cyan/40 font-mono text-[10px] text-bro-cyan font-bold hover:bg-bro-cyan/25 cursor-pointer disabled:opacity-50"
                                >
                                  -&gt; {ns}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Native ANSI X12 EDI Gateway Panel */}
      {ediOpen && (
        <section aria-label="Native ANSI X12 EDI Panel" className="glass-panel rounded-lg border border-bro-gold/30 p-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-bro-gold" />
              <div>
                <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                  Native ANSI X12 EDI Gateway (204 / 997 / 990 / 214 / 210)
                </h2>
                <p className="font-mono text-[10px] text-slate-400">
                  Deterministic X12 parser &amp; envelope generator · SCAC: BROP
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setX12Input(SAMPLE_X12_204)}
              className="px-3 py-1.5 rounded bg-bro-steel border border-white/15 hover:border-bro-gold/50 font-mono text-[11px] text-bro-gold cursor-pointer"
            >
              Load Sample X12 204 Tender
            </button>
          </div>

          {ediError && (
            <div role="alert" className="px-3.5 py-2.5 rounded bg-rose-950/60 border border-bro-crimson/40 font-mono text-xs text-rose-200">
              {ediError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Inbound X12 204 Editor */}
            <div className="space-y-3">
              <label htmlFor="x12-204-input" className="block font-mono text-[11px] uppercase text-slate-300">
                Inbound X12 204 Motor Carrier Load Tender Payload
              </label>
              <textarea
                id="x12-204-input"
                rows={10}
                value={x12Input}
                onChange={(e) => setX12Input(e.target.value)}
                className="w-full rounded bg-bro-obsidian border border-white/15 focus:border-bro-gold p-3 font-mono text-[11px] text-emerald-300 leading-relaxed outline-none"
              />
              <button
                type="button"
                disabled={ediBusy || !x12Input.trim()}
                onClick={() => void handleIngestEdi204()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded bg-bro-gold text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-amber-400 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {ediBusy ? 'Processing X12 204...' : 'Ingest X12 204 Tender -> Generate 997 Ack'}
              </button>
            </div>

            {/* Parsed 204 + 997 Ack + 1-Click 990 / 214 Actions */}
            <div className="space-y-3">
              {inboundResult ? (
                <div className="p-4 rounded-lg bg-bro-obsidian/90 border border-bro-cyan/35 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-mono text-xs font-bold text-bro-cyan">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Parsed Load: {inboundResult.loadNumber}
                    </div>
                    <span className="font-mono text-xs font-bold text-white tabular-nums">
                      {formatCents(inboundResult.parsed.rateCents, 'USD')}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[11px]">
                    <div className="p-2 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] text-slate-400">SCAC / Ctrl</div>
                      <div className="text-white">{inboundResult.parsed.scac} / {inboundResult.parsed.controlNumber}</div>
                    </div>
                    <div className="p-2 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] text-slate-400">Weight</div>
                      <div className="text-white tabular-nums">{inboundResult.parsed.weightLbs.toLocaleString()} lbs</div>
                    </div>
                    <div className="p-2 rounded bg-bro-steel/70 border border-white/10">
                      <div className="text-[10px] text-slate-400">Stops Parsed</div>
                      <div className="text-white tabular-nums">{inboundResult.parsed.stops.length} stops</div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="font-mono text-[10px] uppercase text-slate-400">Auto-Generated X12 997 Functional Ack</div>
                    <pre className="p-2.5 rounded bg-black/60 border border-white/10 font-mono text-[10px] text-bro-cyan overflow-x-auto max-h-32">
                      {inboundResult.ack997}
                    </pre>
                  </div>

                  {/* 1-Click 990 & 214 Controls */}
                  <div className="pt-2 border-t border-white/10 space-y-2.5">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={ediBusy}
                        onClick={() => void handleSend990(inboundResult.loadId, 'A')}
                        className="px-3 py-1.5 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/50 font-mono text-[11px] font-bold text-emerald-300 cursor-pointer disabled:opacity-50"
                      >
                        1-Click Send 990 Accept
                      </button>
                      <button
                        type="button"
                        disabled={ediBusy}
                        onClick={() => void handleSend990(inboundResult.loadId, 'D')}
                        className="px-3 py-1.5 rounded bg-rose-950/70 hover:bg-rose-900/70 border border-bro-crimson/40 font-mono text-[11px] text-rose-200 cursor-pointer disabled:opacity-50"
                      >
                        Send 990 Decline
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={edi214Code}
                        onChange={(e) => setEdi214Code(e.target.value as 'X3' | 'AF' | 'X1' | 'D1' | 'AG')}
                        aria-label="EDI 214 status code"
                        className="bg-bro-steel border border-white/15 rounded px-2 py-1.5 font-mono text-[11px] text-white"
                      >
                        <option value="X3">X3 - Arrived Pickup</option>
                        <option value="AF">AF - Departed / In Transit</option>
                        <option value="X1">X1 - Arrived Delivery</option>
                        <option value="D1">D1 - Completed Delivery</option>
                        <option value="AG">AG - Estimated ETA</option>
                      </select>
                      <input
                        type="text"
                        value={edi214City}
                        onChange={(e) => setEdi214City(e.target.value)}
                        aria-label="EDI 214 city"
                        placeholder="City"
                        className="w-28 bg-bro-steel border border-white/15 rounded px-2 py-1.5 font-mono text-[11px] text-white"
                      />
                      <input
                        type="text"
                        value={edi214State}
                        onChange={(e) => setEdi214State(e.target.value)}
                        aria-label="EDI 214 state or province"
                        placeholder="ST"
                        maxLength={2}
                        className="w-14 bg-bro-steel border border-white/15 rounded px-2 py-1.5 font-mono text-[11px] text-white uppercase"
                      />
                      <button
                        type="button"
                        disabled={ediBusy}
                        onClick={() => void handleSend214(inboundResult.loadId)}
                        className="px-3 py-1.5 rounded bg-bro-cyan/15 hover:bg-bro-cyan/25 border border-bro-cyan/45 font-mono text-[11px] font-bold text-bro-cyan cursor-pointer disabled:opacity-50"
                      >
                        Send 214 Status
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-6 rounded-lg bg-bro-obsidian/60 border border-dashed border-white/15 text-center font-mono text-xs text-slate-400 space-y-2">
                  <Code2 className="w-6 h-6 text-bro-gold mx-auto" />
                  <p>Paste an ANSI X12 <span className="text-white font-bold">204</span> load tender on the left and click Ingest.</p>
                  <p className="text-[11px] text-slate-500">
                    The worker parses ST*204, creates a QUOTED load in D1, emits an OpsHub broadcast, and returns a live 997 Ack with 1-click 990/214 transmission controls.
                  </p>
                </div>
              )}

              {outboundX12Preview && (
                <div className="p-3 rounded-lg bg-bro-obsidian border border-emerald-500/35 space-y-1.5">
                  <div className="font-mono text-[10px] font-bold uppercase text-emerald-300">
                    {outboundX12Preview.label}
                  </div>
                  <pre className="p-2 rounded bg-black/60 font-mono text-[10px] text-emerald-200 overflow-x-auto max-h-36">
                    {outboundX12Preview.rawX12}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* EDI Transaction Log */}
          <div className="space-y-2">
            <div className="font-mono text-[11px] font-bold uppercase text-slate-300">
              Recent EDI Transmission Log ({ediMessages.length})
            </div>
            <div className="overflow-x-auto rounded border border-white/10">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-bro-obsidian/70 font-mono text-[10px] uppercase text-slate-400">
                    <th className="px-3 py-2">Set</th>
                    <th className="px-3 py-2">Direction</th>
                    <th className="px-3 py-2">Control #</th>
                    <th className="px-3 py-2">Load ID</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Envelope</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-[11px]">
                  {ediMessages.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-5 text-center text-slate-500">
                        No EDI messages transmitted yet.
                      </td>
                    </tr>
                  ) : (
                    ediMessages.slice(0, 15).map((m) => (
                      <tr key={m.id} className="hover:bg-white/5">
                        <td className="px-3 py-2 font-bold text-bro-gold">X12 {m.transactionSet}</td>
                        <td className="px-3 py-2 uppercase text-slate-300">{m.direction}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-300">{m.controlNumber}</td>
                        <td className="px-3 py-2 text-slate-400">{m.loadId || '—'}</td>
                        <td className="px-3 py-2">
                          <span className="px-1.5 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-500/30 text-[10px] uppercase">
                            {m.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedEdiMsgId(selectedEdiMsgId === m.id ? null : m.id)}
                            className="text-bro-cyan hover:text-cyan-300 underline cursor-pointer text-[10px]"
                          >
                            {selectedEdiMsgId === m.id ? 'Hide X12' : 'Inspect X12'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {selectedEdiMsg && (
              <pre className="p-3 rounded bg-bro-obsidian border border-bro-cyan/30 font-mono text-[10px] text-slate-200 overflow-x-auto">
                {selectedEdiMsg.rawX12}
              </pre>
            )}
          </div>
        </section>
      )}

      {/* Accessible Driver / Tractor / Trailer Assignment Modal */}
      {assignModalLoad && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="assign-modal-title"
        >
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setAssignModalLoad(null)} />
          <div className="relative z-10 w-full max-w-lg rounded-lg bg-bro-obsidian border border-bro-cyan/40 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-bro-cyan" />
                <h3 id="assign-modal-title" className="font-mono text-sm font-bold text-white">
                  Assign Assets — {assignModalLoad.loadNumber}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAssignModalLoad(null)}
                aria-label="Close assignment modal"
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAssignSubmit} className="p-5 space-y-4">
              {assignError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3.5 rounded-lg bg-rose-950/70 border border-bro-crimson/60 text-rose-100 text-xs font-mono"
                >
                  <ShieldAlert className="w-4 h-4 text-bro-crimson shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-bro-crimson uppercase">DVIR Safety Lock Enforced</div>
                    <div className="mt-0.5">{assignError}</div>
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="assign-driver" className="block font-mono text-[11px] uppercase text-slate-300 mb-1.5">
                  Commercial Driver
                </label>
                <select
                  id="assign-driver"
                  ref={assignFocusRef}
                  value={assignDriverId}
                  onChange={(e) => setAssignDriverId(e.target.value)}
                  className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white outline-none focus:border-bro-cyan"
                >
                  <option value="">-- Select Driver --</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.fullName} ({d.equipmentDivision.toUpperCase()} · {d.status})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="assign-tractor" className="block font-mono text-[11px] uppercase text-slate-300 mb-1.5">
                  Power Unit (Tractor)
                </label>
                <select
                  id="assign-tractor"
                  value={assignTractorId}
                  onChange={(e) => setAssignTractorId(e.target.value)}
                  className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white outline-none focus:border-bro-cyan"
                >
                  <option value="">-- Select Tractor --</option>
                  {tractors.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.unitNumber} · {eq.plate} ({eq.jurisdiction})
                      {eq.status === 'out_of_service' ? ' [OUT OF SERVICE - SAFETY LOCKED]' : ` [${eq.status.toUpperCase()}]`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="assign-trailer" className="block font-mono text-[11px] uppercase text-slate-300 mb-1.5">
                  Commercial Trailer ({assignModalLoad.equipmentType.replace(/_/g, ' ').toUpperCase()})
                </label>
                <select
                  id="assign-trailer"
                  value={assignTrailerId}
                  onChange={(e) => setAssignTrailerId(e.target.value)}
                  className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white outline-none focus:border-bro-cyan"
                >
                  <option value="">-- Select Trailer --</option>
                  {trailers.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.unitNumber} ({eq.type.toUpperCase()}) · {eq.plate}
                      {eq.status === 'out_of_service' ? ' [OUT OF SERVICE - SAFETY LOCKED]' : ` [${eq.status.toUpperCase()}]`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setAssignModalLoad(null)}
                  className="px-4 py-2 rounded border border-white/15 font-mono text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={assignBusy}
                  className="px-4 py-2 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                >
                  {assignBusy ? 'Dispatching...' : 'Confirm Dispatch Assignment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Accessible Create New Load Modal */}
      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-load-title"
        >
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setCreateOpen(false)} />
          <div className="relative z-10 w-full max-w-2xl rounded-lg bg-bro-obsidian border border-bro-cyan/40 shadow-2xl overflow-hidden my-8">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 id="create-load-title" className="font-mono text-sm font-bold text-white uppercase">
                Book New Commercial Freight Load
              </h3>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                aria-label="Close new load dialog"
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateLoad} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
              {createError && (
                <div role="alert" className="p-3 rounded bg-rose-950/60 border border-bro-crimson/50 font-mono text-xs text-rose-200 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-bro-crimson shrink-0" />
                  <span>{createError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Shipper Org ID</label>
                  <select
                    value={newLoadForm.shipperOrgId}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, shipperOrgId: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white"
                  >
                    <option value="org_cavendish_produce">org_cavendish_produce (Cavendish Valley Produce)</option>
                    <option value="org_fundy_steel">org_fundy_steel (Fundy Structural Steel)</option>
                    <option value="org_bro_internal">org_bro_internal (#BRO Internal)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Commercial Division</label>
                  <select
                    value={newLoadForm.equipmentType}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, equipmentType: e.target.value as EquipmentType })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white"
                  >
                    <option value="dry_van">Dry Van (53ft)</option>
                    <option value="reefer">Reefer (53ft Cold-Chain)</option>
                    <option value="flatbed">Flatbed (53ft Tandem)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Corridor Direction</label>
                  <select
                    value={newLoadForm.direction}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, direction: e.target.value as LoadDirection })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white"
                  >
                    <option value="ca_to_us">Canada -&gt; United States (ACE PAPS)</option>
                    <option value="us_to_ca">United States -&gt; Canada (ACI PARS)</option>
                    <option value="domestic_ca">Domestic Canada</option>
                    <option value="domestic_us">Domestic United States</option>
                  </select>
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Commodity</label>
                  <input
                    ref={createFocusRef}
                    type="text"
                    required
                    value={newLoadForm.commodity}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, commodity: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Weight (lbs, max 45,000)</label>
                  <input
                    type="number"
                    min={1}
                    max={45000}
                    required
                    value={newLoadForm.weightLbs}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, weightLbs: Number(e.target.value) })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-2 text-xs font-mono text-white tabular-nums"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Customer ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="10"
                      required
                      value={newLoadForm.rateCustomerDollars}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, rateCustomerDollars: e.target.value })}
                      className="w-full rounded bg-bro-steel border border-white/15 px-2 py-2 text-xs font-mono text-white tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Carrier ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newLoadForm.rateCarrierDollars}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, rateCarrierDollars: e.target.value })}
                      className="w-full rounded bg-bro-steel border border-white/15 px-2 py-2 text-xs font-mono text-white tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Currency</label>
                    <select
                      value={newLoadForm.currency}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, currency: e.target.value as 'CAD' | 'USD' })}
                      className="w-full rounded bg-bro-steel border border-white/15 px-2 py-2 text-xs font-mono text-white"
                    >
                      <option value="CAD">CAD</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-1">
                <label className="inline-flex items-center gap-2 font-mono text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newLoadForm.isFoodFda}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, isFoodFda: e.target.checked })}
                    className="rounded border-white/20"
                  />
                  Perishable / FDA 2-Hr Prior Notice Required
                </label>

                {newLoadForm.equipmentType === 'reefer' && (
                  <div className="inline-flex items-center gap-2">
                    <label className="font-mono text-[10px] uppercase text-slate-400">Reefer Setpoint (°C)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="-30"
                      max="25"
                      value={newLoadForm.tempSetpointC}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, tempSetpointC: e.target.value })}
                      className="w-20 rounded bg-bro-steel border border-white/15 px-2 py-1 text-xs font-mono text-white tabular-nums"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-white/10">
                <div className="space-y-2">
                  <div className="font-mono text-[10px] uppercase font-bold text-bro-cyan">Stop 1 — Pickup</div>
                  <input
                    type="text"
                    required
                    placeholder="Facility Name"
                    value={newLoadForm.pickupFacility}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, pickupFacility: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <input
                    type="text"
                    required
                    placeholder="Full Address"
                    value={newLoadForm.pickupAddress}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, pickupAddress: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-mono text-[10px] uppercase font-bold text-bro-gold">Stop 2 — Delivery</div>
                  <input
                    type="text"
                    required
                    placeholder="Facility Name"
                    value={newLoadForm.deliveryFacility}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, deliveryFacility: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <input
                    type="text"
                    required
                    placeholder="Full Address"
                    value={newLoadForm.deliveryAddress}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, deliveryAddress: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 rounded border border-white/15 font-mono text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createBusy}
                  className="px-4 py-2 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
                >
                  {createBusy ? 'Booking...' : 'Create Load'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
