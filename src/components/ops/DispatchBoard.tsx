import { useState, useEffect, useCallback, useRef, type RefObject, type SyntheticEvent } from 'react';
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
  Sparkles,
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
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

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

interface OrganizationRow {
  id: string;
  name: string;
  type: 'shipper' | 'carrier' | 'factor' | 'internal';
  currency: 'CAD' | 'USD';
  status: string;
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

interface NewLoadFormState {
  shipperOrgId: string;
  equipmentType: EquipmentType;
  direction: LoadDirection;
  commodity: string;
  weightLbs: string;
  rateCustomerDollars: string;
  rateCarrierDollars: string;
  currency: 'CAD' | 'USD';
  isFoodFda: boolean;
  tempSetpointC: string;
  pickupFacility: string;
  pickupAddress: string;
  pickupLat: string;
  pickupLon: string;
  deliveryFacility: string;
  deliveryAddress: string;
  deliveryLat: string;
  deliveryLon: string;
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
  QUOTED: 'bg-slate-800 text-slate-200 border-slate-600',
  BOOKED: 'bg-sky-950/70 text-sky-200 border-sky-400/40',
  DISPATCHED: 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40',
  AT_PICKUP: 'bg-indigo-950/70 text-indigo-200 border-indigo-400/40',
  IN_TRANSIT: 'bg-bro-cyan/20 text-bro-cyan border-bro-cyan/50',
  AT_BORDER: 'bg-bro-gold/15 text-bro-gold border-bro-gold/45',
  CLEARED: 'bg-emerald-950/70 text-emerald-200 border-emerald-400/40',
  AT_DELIVERY: 'bg-teal-950/70 text-teal-200 border-teal-400/40',
  DELIVERED: 'bg-emerald-950/70 text-emerald-200 border-emerald-400/50',
  INVOICED: 'bg-violet-950/70 text-violet-200 border-violet-400/40',
  PAID: 'bg-emerald-900/70 text-emerald-100 border-emerald-400/60',
};

function createEmptyLoadForm(): NewLoadFormState {
  return {
    shipperOrgId: '',
    equipmentType: 'dry_van',
    direction: 'ca_to_us',
    commodity: '',
    weightLbs: '',
    rateCustomerDollars: '',
    rateCarrierDollars: '',
    currency: 'CAD',
    isFoodFda: false,
    tempSetpointC: '',
    pickupFacility: '',
    pickupAddress: '',
    pickupLat: '46.3959',
    pickupLon: '-63.7876',
    deliveryFacility: '',
    deliveryAddress: '',
    deliveryLat: '42.3601',
    deliveryLon: '-71.0589',
  };
}

function formatCents(cents: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  const formatted = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}$${formatted} ${currency}`;
}

export default function DispatchBoard() {
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
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
  const [renderedAssignLoad, setRenderedAssignLoad] = useState<LoadRow | null>(null);
  const [assignDriverId, setAssignDriverId] = useState('');
  const [assignTractorId, setAssignTractorId] = useState('');
  const [assignTrailerId, setAssignTrailerId] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const assignFocusRef = useRef<HTMLSelectElement | null>(null);

  // Create New Load modal state (starts clean with empty defaults)
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createFocusRef = useRef<HTMLInputElement | null>(null);
  const [newLoadForm, setNewLoadForm] = useState<NewLoadFormState>(() => createEmptyLoadForm());

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

  const closeAssignModal = useCallback(() => {
    setAssignModalLoad(null);
  }, []);

  const closeCreateModal = useCallback(() => {
    setCreateOpen(false);
  }, []);

  const assignModal = useModalFocusTrap<HTMLDivElement, HTMLElement>({
    open: Boolean(assignModalLoad),
    onClose: closeAssignModal,
    initialFocusRef: assignFocusRef as unknown as RefObject<HTMLElement | null>,
  });

  const createModal = useModalFocusTrap<HTMLDivElement, HTMLInputElement>({
    open: createOpen,
    onClose: closeCreateModal,
    initialFocusRef: createFocusRef,
  });

  useEffect(() => {
    if (assignModalLoad) {
      setRenderedAssignLoad(assignModalLoad);
    }
  }, [assignModalLoad]);

  const fetchAll = useCallback(async () => {
    try {
      const [loadsRes, ediRes, orgsRes] = await Promise.all([
        fetch('/api/ops/loads'),
        fetch('/api/ops/edi/messages'),
        fetch('/api/ops/carriers'),
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

      if (orgsRes.ok) {
        const orgData = (await orgsRes.json()) as { organizations?: OrganizationRow[] };
        setOrganizations(orgData.organizations || []);
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

  const openAssignModal = (load: LoadRow) => {
    setAssignModalLoad(load);
    setRenderedAssignLoad(load);
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

  const handleFillSampleLoad = () => {
    const preferredOrg =
      organizations.find((o) => o.type === 'shipper') ||
      organizations.find((o) => o.type === 'internal') ||
      organizations[0];

    setCreateError(
      preferredOrg
        ? null
        : 'No shipper organizations found in D1 yet. Initialize fleet seed in Admin or register a shipper first.',
    );

    setNewLoadForm({
      shipperOrgId: preferredOrg?.id ?? '',
      equipmentType: 'reefer',
      direction: 'ca_to_us',
      commodity: 'Chilled PEI Potatoes & Fresh Produce',
      weightLbs: '38000',
      rateCustomerDollars: '3850.00',
      rateCarrierDollars: '2350.00',
      currency: preferredOrg?.currency ?? 'CAD',
      isFoodFda: true,
      tempSetpointC: '4.0',
      pickupFacility: 'Atlantic Harvest Cold Storage',
      pickupAddress: '100 Harvest Rd, Summerside, PE',
      pickupLat: '46.3959',
      pickupLon: '-63.7876',
      deliveryFacility: 'New England Fresh Market Hub',
      deliveryAddress: '45 Terminal Way, Boston, MA',
      deliveryLat: '42.3601',
      deliveryLon: '-71.0589',
    });
  };

  const handleCreateLoad = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);

    if (!newLoadForm.shipperOrgId.trim()) {
      setCreateError('Please select a valid Shipper Organization before booking a load.');
      setCreateBusy(false);
      return;
    }

    const parsedWeight = Number(newLoadForm.weightLbs);
    if (!Number.isFinite(parsedWeight) || parsedWeight < 1 || parsedWeight > 45000) {
      setCreateError('Weight must be between 1 and 45,000 lbs.');
      setCreateBusy(false);
      return;
    }

    const rateCustomerCents = Math.round(Number(newLoadForm.rateCustomerDollars) * 100);
    const rateCarrierCents = Math.round(Number(newLoadForm.rateCarrierDollars || '0') * 100);
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
      weightLbs: Math.round(parsedWeight),
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
        setNewLoadForm(createEmptyLoadForm());
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
  const orgMap = new Map(organizations.map((o) => [o.id, o]));
  const tractors = equipment.filter((e) => e.type === 'tractor');
  const trailers = equipment.filter((e) => e.type !== 'tractor');
  const sortedOrganizations = [...organizations].sort((a, b) => {
    const rank = (t: OrganizationRow['type']) => (t === 'shipper' ? 0 : t === 'internal' ? 1 : 2);
    return rank(a.type) - rank(b.type);
  });

  const filteredLoads = loads.filter((l) => {
    if (statusFilter !== 'ALL' && l.status !== statusFilter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const orgName = orgMap.get(l.shipperOrgId)?.name?.toLowerCase() ?? '';
    return (
      l.loadNumber.toLowerCase().includes(q) ||
      l.commodity.toLowerCase().includes(q) ||
      l.equipmentType.toLowerCase().includes(q) ||
      l.shipperOrgId.toLowerCase().includes(q) ||
      orgName.includes(q)
    );
  });

  const selectedEdiMsg = ediMessages.find((m) => m.id === selectedEdiMsgId) || null;

  return (
    <div className="space-y-6">
      {/* Top Action Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-cyan">
            11-State Commercial TMS · ANSI X12 EDI Gateway
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Dispatch Board &amp; EDI Engine
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="group"
            aria-label="Dispatch view mode"
            className="inline-flex rounded-full border border-white/10 bg-[#060912] p-1"
          >
            <button
              type="button"
              aria-pressed={viewMode === 'table'}
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 min-h-[40px] rounded-full text-xs font-medium cursor-pointer transition-colors ${
                viewMode === 'table' ? 'bg-white text-black font-semibold shadow-sm' : 'text-slate-300 hover:text-white'
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Table</span>
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'kanban'}
              onClick={() => setViewMode('kanban')}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 min-h-[40px] rounded-full text-xs font-medium cursor-pointer transition-colors ${
                viewMode === 'kanban' ? 'bg-white text-black font-semibold shadow-sm' : 'text-slate-300 hover:text-white'
              }`}
            >
              <Columns3 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>11-State Kanban</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setEdiOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-xl border text-xs font-semibold cursor-pointer transition-colors ${
              ediOpen
                ? 'bg-bro-gold/15 border-bro-gold/45 text-bro-gold'
                : 'bg-[#0b1120] border-white/15 text-slate-300 hover:text-white'
            }`}
          >
            <Code2 className="w-4 h-4" aria-hidden="true" />
            <span>X12 EDI Panel ({ediMessages.length})</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>New Load</span>
          </button>

          <button
            type="button"
            onClick={() => void fetchAll()}
            aria-label="Refresh loads"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-slate-200 hover:text-white cursor-pointer transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
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

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="text"
            aria-label="Filter loads by load number, commodity, equipment, or shipper"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by load #, commodity, equipment, shipper..."
            className="w-full pl-10 pr-4 py-2.5 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan text-xs text-white placeholder:text-slate-400 outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={`px-3.5 py-2 min-h-[40px] rounded-full text-xs uppercase whitespace-nowrap border cursor-pointer transition-colors ${
              statusFilter === 'ALL'
                ? 'bg-white text-black border-white font-semibold'
                : 'bg-[#0b1120] border-white/10 text-slate-300 hover:text-white'
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
                className={`px-3 py-2 min-h-[40px] rounded-full text-xs uppercase whitespace-nowrap border cursor-pointer transition-colors tabular-nums ${
                  statusFilter === st
                    ? 'bg-bro-gold/20 border-bro-gold/50 text-bro-gold font-bold'
                    : 'bg-[#0b1120] border-white/10 text-slate-300 hover:text-white'
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
        <section aria-label="Load Lifecycle Table" className="surface-ceramic rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                  <th className="px-4 py-3">Load # / Corridor</th>
                  <th className="px-4 py-3">Freight &amp; Division</th>
                  <th className="px-4 py-3">Assigned Assets</th>
                  <th className="px-4 py-3 text-right">Customer / Carrier</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Dispatch Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {filteredLoads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-300">
                      {loading ? 'Loading 11-state TMS loads...' : 'No loads match the current filter.'}
                    </td>
                  </tr>
                ) : (
                  filteredLoads.map((load) => {
                    const drv = load.assignedDriverId ? driverMap.get(load.assignedDriverId) : null;
                    const trc = load.tractorId ? equipMap.get(load.tractorId) : null;
                    const trl = load.trailerId ? equipMap.get(load.trailerId) : null;
                    const org = orgMap.get(load.shipperOrgId);
                    const nextStates = ALLOWED_STATUS_TRANSITIONS[load.status] || [];
                    const isBusy = busyLoadId === load.id;
                    return (
                      <tr key={load.id} className="hover:bg-white/[0.03]">
                        <td className="px-4 py-3.5 align-top whitespace-nowrap">
                          <div className="font-mono font-bold text-white tabular-nums">{load.loadNumber}</div>
                          <div className="text-xs text-slate-400 mt-1">
                            {load.direction.replace(/_/g, ' ').toUpperCase()} · {org?.name || load.shipperOrgId}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="text-sm text-slate-100 font-medium">{load.commodity}</div>
                          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
                            <span className="px-2.5 py-0.5 rounded-full bg-[#0b1120] border border-white/10 uppercase text-bro-cyan font-semibold">
                              {load.equipmentType.replace(/_/g, ' ')}
                            </span>
                            <span className="text-slate-300 tabular-nums font-mono">
                              {load.weightLbs.toLocaleString()} lbs
                            </span>
                            {load.tempSetpointC !== null && (
                              <span className="text-sky-200 tabular-nums font-mono">{load.tempSetpointC.toFixed(1)}°C</span>
                            )}
                            {load.isFoodFda && (
                              <span className="px-2.5 py-0.5 rounded-full bg-amber-950/70 text-amber-200 border border-amber-400/35 font-semibold">
                                FDA 2-Hr
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top text-xs whitespace-nowrap">
                          <div className="text-slate-100 font-medium">
                            {drv ? drv.fullName : <span className="text-slate-400">Unassigned Driver</span>}
                          </div>
                          <div className="font-mono text-xs text-slate-400 mt-1">
                            {trc ? trc.unitNumber : 'No Tractor'} / {trl ? trl.unitNumber : 'No Trailer'}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top text-right font-mono whitespace-nowrap tabular-nums">
                          <div className="text-white font-semibold">{formatCents(load.rateCustomerCents, load.currency)}</div>
                          <div className="text-xs text-slate-400 mt-1">
                            Cost: {formatCents(load.rateCarrierCents, load.currency)}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top whitespace-nowrap">
                          <span className={`px-2.5 py-1 rounded-full border text-xs font-semibold ${STATUS_BADGE[load.status]}`}>
                            {load.status}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 align-top text-right whitespace-nowrap">
                          <div className="inline-flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => openAssignModal(load)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-[#0b1120] hover:bg-slate-800 border border-white/15 text-xs font-semibold text-white cursor-pointer transition-colors"
                            >
                              <UserCheck className="w-3.5 h-3.5 text-bro-cyan" aria-hidden="true" />
                              <span>Assign</span>
                            </button>
                            {nextStates.map((ns) => (
                              <button
                                key={ns}
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleAdvanceStatus(load, ns)}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-bro-cyan/15 hover:bg-bro-cyan/25 border border-bro-cyan/40 text-xs text-bro-cyan font-bold cursor-pointer disabled:opacity-50 transition-colors"
                              >
                                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>{ns}</span>
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
          <div className="flex gap-3.5 min-w-max">
            {ALL_STATES.map((stage) => {
              const colLoads = filteredLoads.filter((l) => l.status === stage);
              return (
                <div
                  key={stage}
                  className="w-72 shrink-0 surface-ceramic rounded-2xl flex flex-col max-h-[560px] overflow-hidden"
                >
                  <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-[#0b1120]">
                    <span className="text-xs font-bold uppercase text-white">{stage}</span>
                    <span className="px-2.5 py-0.5 rounded-full bg-white/10 font-mono text-xs tabular-nums text-bro-cyan">
                      {colLoads.length}
                    </span>
                  </div>
                  <div className="p-3 space-y-3 overflow-y-auto flex-1">
                    {colLoads.length === 0 ? (
                      <div className="py-8 text-center text-xs text-slate-400">Empty stage</div>
                    ) : (
                      colLoads.map((load) => {
                        const drv = load.assignedDriverId ? driverMap.get(load.assignedDriverId) : null;
                        const nextStates = ALLOWED_STATUS_TRANSITIONS[load.status] || [];
                        return (
                          <div
                            key={load.id}
                            className="p-3.5 rounded-xl bg-[#0b1120] border border-white/10 space-y-2.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs font-bold text-white tabular-nums">{load.loadNumber}</span>
                              <span className="text-xs uppercase font-semibold text-bro-gold">
                                {load.equipmentType.replace(/_/g, ' ')}
                              </span>
                            </div>
                            <p className="text-xs text-slate-200 line-clamp-2">{load.commodity}</p>
                            <div className="flex items-center justify-between text-xs text-slate-300">
                              <span className="truncate">{drv ? drv.fullName : 'Unassigned'}</span>
                              <span className="font-mono text-white font-semibold tabular-nums">
                                {formatCents(load.rateCustomerCents, load.currency)}
                              </span>
                            </div>
                            <div className="pt-2 border-t border-white/10 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => openAssignModal(load)}
                                className="px-3 py-1.5 min-h-[40px] rounded-xl bg-[#070b16] border border-white/15 text-xs font-medium text-slate-200 hover:text-white cursor-pointer transition-colors"
                              >
                                Assign
                              </button>
                              {nextStates.map((ns) => (
                                <button
                                  key={ns}
                                  type="button"
                                  disabled={busyLoadId === load.id}
                                  onClick={() => void handleAdvanceStatus(load, ns)}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[40px] rounded-xl bg-bro-cyan/15 border border-bro-cyan/40 text-xs text-bro-cyan font-bold hover:bg-bro-cyan/25 cursor-pointer disabled:opacity-50 transition-colors"
                                >
                                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                                  <span>{ns}</span>
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
        <section aria-label="Native ANSI X12 EDI Panel" className="surface-ceramic rounded-2xl border border-bro-gold/30 p-5 sm:p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div className="flex items-center gap-2.5">
              <FileCode2 className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
              <div>
                <h2 className="font-display text-base font-bold text-white">
                  Native ANSI X12 EDI Gateway (204 / 997 / 990 / 214 / 210)
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Deterministic X12 parser &amp; envelope generator · SCAC: BROP
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setX12Input(SAMPLE_X12_204)}
              className="px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-gold/50 text-xs font-semibold text-bro-gold cursor-pointer transition-colors"
            >
              Load Sample X12 204 Tender
            </button>
          </div>

          {ediError && (
            <div role="alert" className="px-4 py-3 rounded-xl bg-rose-950/60 border border-rose-400/50 text-xs text-rose-200">
              {ediError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Inbound X12 204 Editor */}
            <div className="space-y-3">
              <label htmlFor="x12-204-input" className="block text-xs font-medium text-slate-300">
                Inbound X12 204 Motor Carrier Load Tender Payload
              </label>
              <textarea
                id="x12-204-input"
                rows={10}
                value={x12Input}
                onChange={(e) => setX12Input(e.target.value)}
                className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-gold p-3.5 font-mono text-xs text-emerald-200 leading-relaxed outline-none"
              />
              <button
                type="button"
                disabled={ediBusy || !x12Input.trim()}
                onClick={() => void handleIngestEdi204()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-bro-gold text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-amber-400 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <Send className="w-4 h-4" aria-hidden="true" />
                <span>{ediBusy ? 'Processing X12 204...' : 'Ingest X12 204 Tender & Generate 997 Ack'}</span>
              </button>
            </div>

            {/* Parsed 204 + 997 Ack + 1-Click 990 / 214 Actions */}
            <div className="space-y-3">
              {inboundResult ? (
                <div className="p-4 rounded-2xl bg-[#0b1120] border border-bro-cyan/35 space-y-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-bro-cyan">
                      <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" aria-hidden="true" />
                      <span>Parsed Load: {inboundResult.loadNumber}</span>
                    </div>
                    <span className="font-mono text-xs font-bold text-white tabular-nums">
                      {formatCents(inboundResult.parsed.rateCents, 'USD')}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                    <div className="p-2.5 rounded-xl bg-[#070b16] border border-white/10">
                      <div className="text-xs text-slate-400">SCAC / Ctrl</div>
                      <div className="font-mono text-white mt-0.5">
                        {inboundResult.parsed.scac} / {inboundResult.parsed.controlNumber}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#070b16] border border-white/10">
                      <div className="text-xs text-slate-400">Weight</div>
                      <div className="font-mono text-white tabular-nums mt-0.5">
                        {inboundResult.parsed.weightLbs.toLocaleString()} lbs
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#070b16] border border-white/10">
                      <div className="text-xs text-slate-400">Stops Parsed</div>
                      <div className="font-mono text-white tabular-nums mt-0.5">
                        {inboundResult.parsed.stops.length} stops
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-slate-300">Auto-Generated X12 997 Functional Ack</div>
                    <pre className="p-3 rounded-xl bg-[#050811] border border-white/10 font-mono text-xs text-bro-cyan overflow-x-auto max-h-32">
                      {inboundResult.ack997}
                    </pre>
                  </div>

                  {/* 1-Click 990 & 214 Controls */}
                  <div className="pt-3 border-t border-white/10 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={ediBusy}
                        onClick={() => void handleSend990(inboundResult.loadId, 'A')}
                        className="px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-400/50 text-xs font-bold text-emerald-200 cursor-pointer disabled:opacity-50 transition-colors"
                      >
                        1-Click Send 990 Accept
                      </button>
                      <button
                        type="button"
                        disabled={ediBusy}
                        onClick={() => void handleSend990(inboundResult.loadId, 'D')}
                        className="px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-rose-700 hover:bg-rose-600 text-xs font-semibold text-white cursor-pointer disabled:opacity-50 transition-colors"
                      >
                        Send 990 Decline
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={edi214Code}
                        onChange={(e) => setEdi214Code(e.target.value as 'X3' | 'AF' | 'X1' | 'D1' | 'AG')}
                        aria-label="EDI 214 status code"
                        className="bg-[#070b16] border border-white/15 focus:border-bro-cyan rounded-xl px-3 py-2 min-h-[40px] font-mono text-xs text-white outline-none"
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
                        className="w-32 bg-[#070b16] border border-white/15 focus:border-bro-cyan rounded-xl px-3 py-2 min-h-[40px] font-mono text-xs text-white placeholder:text-slate-400 outline-none"
                      />
                      <input
                        type="text"
                        value={edi214State}
                        onChange={(e) => setEdi214State(e.target.value)}
                        aria-label="EDI 214 state or province"
                        placeholder="ST"
                        maxLength={2}
                        className="w-16 bg-[#070b16] border border-white/15 focus:border-bro-cyan rounded-xl px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                      />
                      <button
                        type="button"
                        disabled={ediBusy}
                        onClick={() => void handleSend214(inboundResult.loadId)}
                        className="px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-bro-cyan/15 hover:bg-bro-cyan/25 border border-bro-cyan/45 text-xs font-bold text-bro-cyan cursor-pointer disabled:opacity-50 transition-colors"
                      >
                        Send 214 Status
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-6 rounded-2xl bg-[#0b1120] border border-dashed border-white/15 text-center text-xs text-slate-300 space-y-2.5">
                  <Code2 className="w-6 h-6 text-bro-gold mx-auto" aria-hidden="true" />
                  <p>
                    Paste an ANSI X12 <span className="text-white font-bold">204</span> load tender on the left and click Ingest.
                  </p>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    The worker parses ST*204, creates a QUOTED load in D1, emits an OpsHub broadcast, and returns a live 997 Ack with 1-click 990/214 transmission controls.
                  </p>
                </div>
              )}

              {outboundX12Preview && (
                <div className="p-3.5 rounded-2xl bg-[#0b1120] border border-emerald-400/35 space-y-2">
                  <div className="text-xs font-bold uppercase text-emerald-200">
                    {outboundX12Preview.label}
                  </div>
                  <pre className="p-3 rounded-xl bg-[#050811] font-mono text-xs text-emerald-200 overflow-x-auto max-h-36">
                    {outboundX12Preview.rawX12}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* EDI Transaction Log */}
          <div className="space-y-2.5">
            <div className="text-xs font-semibold text-slate-300">
              Recent EDI Transmission Log ({ediMessages.length})
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                    <th className="px-3.5 py-2.5">Set</th>
                    <th className="px-3.5 py-2.5">Direction</th>
                    <th className="px-3.5 py-2.5">Control #</th>
                    <th className="px-3.5 py-2.5">Load ID</th>
                    <th className="px-3.5 py-2.5">Status</th>
                    <th className="px-3.5 py-2.5 text-right">Envelope</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] font-mono text-xs">
                  {ediMessages.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center font-sans text-slate-300">
                        No EDI messages transmitted yet.
                      </td>
                    </tr>
                  ) : (
                    ediMessages.slice(0, 15).map((m) => (
                      <tr key={m.id} className="hover:bg-white/[0.03]">
                        <td className="px-3.5 py-2.5 font-bold text-bro-gold">X12 {m.transactionSet}</td>
                        <td className="px-3.5 py-2.5 uppercase text-slate-300">{m.direction}</td>
                        <td className="px-3.5 py-2.5 tabular-nums text-slate-300">{m.controlNumber}</td>
                        <td className="px-3.5 py-2.5 text-slate-300">{m.loadId || '—'}</td>
                        <td className="px-3.5 py-2.5">
                          <span className="px-2.5 py-0.5 rounded-full bg-emerald-950/70 text-emerald-200 border border-emerald-400/35 text-xs uppercase">
                            {m.status}
                          </span>
                        </td>
                        <td className="px-3.5 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedEdiMsgId(selectedEdiMsgId === m.id ? null : m.id)}
                            className="px-3 py-1.5 min-h-[36px] rounded-xl text-bro-cyan hover:text-cyan-200 hover:bg-white/[0.05] underline cursor-pointer text-xs transition-colors"
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
              <pre className="p-3.5 rounded-xl bg-[#0b1120] border border-bro-cyan/30 font-mono text-xs text-slate-200 overflow-x-auto">
                {selectedEdiMsg.rawX12}
              </pre>
            )}
          </div>
        </section>
      )}

      {/* Accessible Driver / Tractor / Trailer Assignment Modal */}
      {assignModal.mounted && renderedAssignLoad && (
        <div
          className="fixed inset-0 z-50 flex justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="assign-modal-title"
        >
          <div
            className="bro-modal-backdrop fixed inset-0 bg-black/75 backdrop-blur-sm"
            data-visible={assignModal.visible ? 'true' : 'false'}
            onClick={closeAssignModal}
          />
          <div
            ref={assignModal.containerRef}
            data-visible={assignModal.visible ? 'true' : 'false'}
            className="bro-modal-panel relative z-10 w-full max-w-lg surface-ceramic rounded-2xl border border-bro-cyan/40 shadow-2xl overflow-hidden my-auto"
          >
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Truck className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
                <h3 id="assign-modal-title" className="font-display text-base font-bold text-white">
                  Assign Assets — {renderedAssignLoad.loadNumber}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeAssignModal}
                aria-label="Close assignment modal"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAssignSubmit} className="p-5 space-y-4">
              {assignError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3.5 rounded-xl bg-rose-950/70 border border-rose-400/60 text-rose-100 text-xs"
                >
                  <ShieldAlert className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <div className="font-bold text-rose-200 uppercase">DVIR Safety Lock Enforced</div>
                    <div className="mt-0.5">{assignError}</div>
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="assign-driver" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Commercial Driver
                </label>
                <select
                  id="assign-driver"
                  ref={assignFocusRef}
                  value={assignDriverId}
                  onChange={(e) => setAssignDriverId(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
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
                <label htmlFor="assign-tractor" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Power Unit (Tractor)
                </label>
                <select
                  id="assign-tractor"
                  value={assignTractorId}
                  onChange={(e) => setAssignTractorId(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                >
                  <option value="">-- Select Tractor --</option>
                  {tractors.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.unitNumber} · {eq.plate} ({eq.jurisdiction})
                      {eq.status === 'out_of_service' ? ' (Out of Service — Safety Locked)' : ` (${eq.status.toUpperCase()})`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="assign-trailer" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Commercial Trailer ({renderedAssignLoad.equipmentType.replace(/_/g, ' ').toUpperCase()})
                </label>
                <select
                  id="assign-trailer"
                  value={assignTrailerId}
                  onChange={(e) => setAssignTrailerId(e.target.value)}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                >
                  <option value="">-- Select Trailer --</option>
                  {trailers.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.unitNumber} ({eq.type.toUpperCase()}) · {eq.plate}
                      {eq.status === 'out_of_service' ? ' (Out of Service — Safety Locked)' : ` (${eq.status.toUpperCase()})`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={closeAssignModal}
                  className="px-4 py-2 min-h-[44px] rounded-xl border border-white/15 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={assignBusy}
                  className="px-5 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
                >
                  {assignBusy ? 'Dispatching...' : 'Confirm Dispatch Assignment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Accessible Create New Load Modal */}
      {createModal.mounted && (
        <div
          className="fixed inset-0 z-50 flex justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-load-title"
        >
          <div
            className="bro-modal-backdrop fixed inset-0 bg-black/75 backdrop-blur-sm"
            data-visible={createModal.visible ? 'true' : 'false'}
            onClick={closeCreateModal}
          />
          <div
            ref={createModal.containerRef}
            data-visible={createModal.visible ? 'true' : 'false'}
            className="bro-modal-panel relative z-10 w-full max-w-2xl surface-ceramic rounded-2xl border border-bro-cyan/40 shadow-2xl overflow-hidden my-auto"
          >
            <div className="px-5 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
              <h3 id="create-load-title" className="font-display text-base font-bold text-white">
                Book New Commercial Freight Load
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleFillSampleLoad}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[40px] rounded-xl bg-bro-gold/15 border border-bro-gold/40 hover:bg-bro-gold/25 text-xs font-semibold text-bro-gold cursor-pointer transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Fill Sample Data</span>
                </button>
                <button
                  type="button"
                  onClick={closeCreateModal}
                  aria-label="Close new load dialog"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <form onSubmit={handleCreateLoad} className="p-5 space-y-4">
              {createError && (
                <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-400/50 text-xs text-rose-200 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0" aria-hidden="true" />
                  <span>{createError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="create-shipper-org" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Shipper Organization
                  </label>
                  {sortedOrganizations.length > 0 ? (
                    <select
                      id="create-shipper-org"
                      required
                      value={newLoadForm.shipperOrgId}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        const matched = organizations.find((o) => o.id === nextId);
                        setNewLoadForm({
                          ...newLoadForm,
                          shipperOrgId: nextId,
                          currency: matched?.currency ?? newLoadForm.currency,
                        });
                      }}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                    >
                      <option value="">-- Select Shipper Organization --</option>
                      {sortedOrganizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name} ({org.type.toUpperCase()} · {org.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="space-y-1.5">
                      <input
                        id="create-shipper-org"
                        type="text"
                        required
                        value={newLoadForm.shipperOrgId}
                        onChange={(e) => setNewLoadForm({ ...newLoadForm, shipperOrgId: e.target.value })}
                        placeholder="No orgs loaded — enter existing org ID or seed D1"
                        className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white placeholder:text-slate-400 outline-none"
                      />
                      <p className="text-xs text-bro-gold">
                        No organizations found in D1. Run Fleet Seed in Admin or onboard a shipper first.
                      </p>
                    </div>
                  )}
                </div>

                <div>
                  <label htmlFor="create-equipment-type" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Commercial Division
                  </label>
                  <select
                    id="create-equipment-type"
                    value={newLoadForm.equipmentType}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, equipmentType: e.target.value as EquipmentType })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                  >
                    <option value="dry_van">Dry Van (53ft)</option>
                    <option value="reefer">Reefer (53ft Cold-Chain)</option>
                    <option value="flatbed">Flatbed (53ft Tandem)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="create-direction" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Corridor Direction
                  </label>
                  <select
                    id="create-direction"
                    value={newLoadForm.direction}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, direction: e.target.value as LoadDirection })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white outline-none"
                  >
                    <option value="ca_to_us">Canada → United States (ACE PAPS)</option>
                    <option value="us_to_ca">United States → Canada (ACI PARS)</option>
                    <option value="domestic_ca">Domestic Canada</option>
                    <option value="domestic_us">Domestic United States</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="create-commodity" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Commodity
                  </label>
                  <input
                    id="create-commodity"
                    ref={createFocusRef}
                    type="text"
                    required
                    placeholder="e.g. Chilled Produce / Structural Steel"
                    value={newLoadForm.commodity}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, commodity: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="create-weight" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Weight (lbs, max 45,000)
                  </label>
                  <input
                    id="create-weight"
                    type="number"
                    min={1}
                    max={45000}
                    required
                    placeholder="38000"
                    value={newLoadForm.weightLbs}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, weightLbs: e.target.value })}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                  />
                </div>

                <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="create-customer-rate" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Customer Rate ($)
                    </label>
                    <input
                      id="create-customer-rate"
                      type="number"
                      step="0.01"
                      min="10"
                      required
                      placeholder="3850.00"
                      value={newLoadForm.rateCustomerDollars}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, rateCustomerDollars: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="create-carrier-rate" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Carrier Cost ($)
                    </label>
                    <input
                      id="create-carrier-rate"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="2350.00"
                      value={newLoadForm.rateCarrierDollars}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, rateCarrierDollars: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="create-currency" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Currency
                    </label>
                    <select
                      id="create-currency"
                      value={newLoadForm.currency}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, currency: e.target.value as 'CAD' | 'USD' })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2.5 min-h-[44px] font-mono text-xs text-white outline-none"
                    >
                      <option value="CAD">CAD</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-1">
                <label htmlFor="create-food-fda" className="inline-flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer min-h-[36px]">
                  <input
                    id="create-food-fda"
                    type="checkbox"
                    checked={newLoadForm.isFoodFda}
                    onChange={(e) => setNewLoadForm({ ...newLoadForm, isFoodFda: e.target.checked })}
                    className="w-4 h-4 rounded border-white/25 accent-amber-400 cursor-pointer"
                  />
                  <span>Perishable / FDA 2-Hr Prior Notice Required</span>
                </label>

                {newLoadForm.equipmentType === 'reefer' && (
                  <div className="inline-flex items-center gap-2">
                    <label htmlFor="create-reefer-temp" className="text-xs font-medium text-slate-300">
                      Reefer Setpoint (°C)
                    </label>
                    <input
                      id="create-reefer-temp"
                      type="number"
                      step="0.5"
                      min="-30"
                      max="25"
                      placeholder="4.0"
                      value={newLoadForm.tempSetpointC}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, tempSetpointC: e.target.value })}
                      className="w-24 rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-3 border-t border-white/10">
                <div className="space-y-2.5">
                  <div className="text-xs font-bold uppercase tracking-wide text-bro-cyan">Stop 1 — Pickup</div>
                  <div>
                    <label htmlFor="create-pickup-facility" className="block text-xs text-slate-300 mb-1">
                      Pickup Facility Name
                    </label>
                    <input
                      id="create-pickup-facility"
                      type="text"
                      required
                      placeholder="Facility Name"
                      value={newLoadForm.pickupFacility}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, pickupFacility: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="create-pickup-address" className="block text-xs text-slate-300 mb-1">
                      Pickup Address
                    </label>
                    <input
                      id="create-pickup-address"
                      type="text"
                      required
                      placeholder="Full Address"
                      value={newLoadForm.pickupAddress}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, pickupAddress: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                    />
                  </div>
                </div>
                <div className="space-y-2.5">
                  <div className="text-xs font-bold uppercase tracking-wide text-bro-gold">Stop 2 — Delivery</div>
                  <div>
                    <label htmlFor="create-delivery-facility" className="block text-xs text-slate-300 mb-1">
                      Delivery Facility Name
                    </label>
                    <input
                      id="create-delivery-facility"
                      type="text"
                      required
                      placeholder="Facility Name"
                      value={newLoadForm.deliveryFacility}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, deliveryFacility: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="create-delivery-address" className="block text-xs text-slate-300 mb-1">
                      Delivery Address
                    </label>
                    <input
                      id="create-delivery-address"
                      type="text"
                      required
                      placeholder="Full Address"
                      value={newLoadForm.deliveryAddress}
                      onChange={(e) => setNewLoadForm({ ...newLoadForm, deliveryAddress: e.target.value })}
                      className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={closeCreateModal}
                  className="px-4 py-2 min-h-[44px] rounded-xl border border-white/15 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createBusy}
                  className="px-5 py-2 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
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
