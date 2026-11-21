import { useState, useEffect, useCallback, type SyntheticEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Eraser,
  FileCheck2,
  Globe,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Sparkles,
  X,
} from 'lucide-react';
import {
  NORTH_AMERICAN_PORTS,
  validateVin,
  type CustomsManifestType,
  type CustomsValidationReport,
} from '@bro/contracts';
import { BroWsClient } from '../../lib/wsClient';

interface PortWaitSnapshot {
  cbpCode: string;
  cbsaName: string;
  crossingName: string;
  usCityState: string;
  caCityProv: string;
  highway: string;
  commercialFastLane: boolean;
  northboundCommercialMinutes: number | null;
  southboundCommercialMinutes: number | null;
  southboundFastMinutes: number | null;
  commercialLanesOpen: number | null;
  status: 'open' | 'delayed' | 'congested' | 'unavailable';
  cbsaUpdatedAt: string | null;
  cbpUpdatedAt: string | null;
}

interface BorderWaitFeed {
  fetchedAt: string;
  stale: boolean;
  sources: {
    cbsa: { ok: boolean; error?: string; recordCount: number };
    cbp: { ok: boolean; error?: string; recordCount: number };
  };
  ports: PortWaitSnapshot[];
}

interface CustomsManifestRow {
  id: string;
  loadId: string | null;
  manifestType: CustomsManifestType;
  scacOrCarrierCode: string;
  controlNumber: string;
  tripNumber: string;
  portCode: string;
  etaUtc: string;
  carmIorVerified: boolean;
  fdaPriorNoticeNum: string | null;
  status: 'draft' | 'validated' | 'filed' | 'released' | 'held';
  rnsReleasedAt: number | null;
  coverSheetR2Key: string | null;
  createdAt: number;
  updatedAt: number;
}

interface LoadOptionRow {
  id: string;
  loadNumber: string;
  assignedDriverId: string | null;
  tractorId: string | null;
  direction: string;
  commodity: string;
  weightLbs: number;
  isFoodFda: boolean;
  rateCustomerCents: number;
  currency: 'CAD' | 'USD';
}

interface DriverSummaryRow {
  id: string;
  fullName: string;
  fastCardNumber: string | null;
}

interface EquipmentSummaryRow {
  id: string;
  unitNumber: string;
  type: string;
  vin: string;
  plate: string;
  jurisdiction: string;
}

interface CustomsFormState {
  loadId: string;
  manifestType: CustomsManifestType;
  scacOrCarrierCode: string;
  controlNumber: string;
  tripNumber: string;
  portCode: string;
  etaUtc: string;
  vin: string;
  plate: string;
  jurisdiction: string;
  fastCardNumber: string;
  driverFirstName: string;
  driverLastName: string;
  driverDob: string;
  carmIorAccountVerified: boolean;
  carmImporterBnRm: string;
  isFoodFda: boolean;
  fdaPriorNoticeNumber: string;
  overweightPermitNumber: string;
  commodity: string;
  hsCode: string;
  countryOfOrigin: 'CA' | 'US' | 'MX' | 'OTHER';
  cusmaCertOnFile: boolean;
  invoiceValueDollars: string;
  currency: 'CAD' | 'USD';
  weightKg: string;
  quantity: string;
  packageType: string;
  shipperName: string;
  shipperAddress: string;
  consigneeName: string;
  consigneeAddress: string;
}

function defaultEtaIso(hoursAhead = 3): string {
  const dt = new Date(Date.now() + hoursAhead * 3600_000);
  dt.setSeconds(0, 0);
  return dt.toISOString();
}

function toDatetimeLocalValue(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}

function formatWait(min: number | null): string {
  if (min === null) return 'N/A';
  if (min === 0) return 'No Delay';
  return `${min} min`;
}

function createEmptyCustomsForm(): CustomsFormState {
  return {
    loadId: '',
    manifestType: 'ACE_PAPS',
    scacOrCarrierCode: '',
    controlNumber: '',
    tripNumber: '',
    portCode: '0115',
    etaUtc: defaultEtaIso(3),
    vin: '',
    plate: '',
    jurisdiction: '',
    fastCardNumber: '',
    driverFirstName: '',
    driverLastName: '',
    driverDob: '',
    carmIorAccountVerified: false,
    carmImporterBnRm: '',
    isFoodFda: false,
    fdaPriorNoticeNumber: '',
    overweightPermitNumber: '',
    commodity: '',
    hsCode: '',
    countryOfOrigin: 'CA',
    cusmaCertOnFile: true,
    invoiceValueDollars: '',
    currency: 'CAD',
    weightKg: '',
    quantity: '',
    packageType: 'Pallets',
    shipperName: '',
    shipperAddress: '',
    consigneeName: '',
    consigneeAddress: '',
  };
}

export default function CustomsDesk() {
  const [borderFeed, setBorderFeed] = useState<BorderWaitFeed | null>(null);
  const [manifests, setManifests] = useState<CustomsManifestRow[]>([]);
  const [loads, setLoads] = useState<LoadOptionRow[]>([]);
  const [drivers, setDrivers] = useState<DriverSummaryRow[]>([]);
  const [equipment, setEquipment] = useState<EquipmentSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingBorders, setRefreshingBorders] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [latestFiling, setLatestFiling] = useState<{
    id: string;
    report: CustomsValidationReport;
    coverSheetUrl: string;
  } | null>(null);

  const [form, setForm] = useState<CustomsFormState>(() => createEmptyCustomsForm());

  const fetchData = useCallback(async (isBorderRefresh = false) => {
    if (isBorderRefresh) setRefreshingBorders(true);
    try {
      const [borderRes, manRes, loadsRes] = await Promise.all([
        fetch('/api/borders/wait-times'),
        fetch('/api/ops/customs/manifests'),
        fetch('/api/ops/loads'),
      ]);

      if (borderRes.ok) {
        setBorderFeed((await borderRes.json()) as BorderWaitFeed);
      }
      if (manRes.ok) {
        const mData = (await manRes.json()) as { manifests: CustomsManifestRow[] };
        setManifests(mData.manifests || []);
      } else {
        const err = (await manRes.json().catch(() => ({}))) as { error?: string };
        setBanner({ kind: 'error', text: err.error || `Failed to load customs manifests (HTTP ${manRes.status}).` });
      }
      if (loadsRes.ok) {
        const lData = (await loadsRes.json()) as {
          loads?: LoadOptionRow[];
          drivers?: DriverSummaryRow[];
          equipment?: EquipmentSummaryRow[];
        };
        setLoads(lData.loads || []);
        setDrivers(lData.drivers || []);
        setEquipment(lData.equipment || []);
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error communicating with Customs & Border API.' });
    } finally {
      setLoading(false);
      setRefreshingBorders(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    const client = new BroWsClient('ops:all', (msg) => {
      if (msg.type === 'RNS_CLEARED' || msg.type === 'BORDER_WAIT_UPDATED') {
        void fetchData();
      }
    });
    void client.connect();
    return () => {
      client.disconnect();
    };
  }, [fetchData]);

  const handleSelectExistingLoad = (loadId: string) => {
    if (!loadId) {
      setForm((prev) => ({ ...prev, loadId: '' }));
      return;
    }
    const chosen = loads.find((l) => l.id === loadId);
    if (!chosen) {
      setForm((prev) => ({ ...prev, loadId }));
      return;
    }
    const drv = chosen.assignedDriverId ? drivers.find((d) => d.id === chosen.assignedDriverId) : undefined;
    const trc = chosen.tractorId ? equipment.find((e) => e.id === chosen.tractorId) : undefined;
    const nameParts = drv?.fullName.trim().split(/\s+/) || [];
    const manifestType: CustomsManifestType = chosen.direction === 'us_to_ca' ? 'ACI_PARS' : 'ACE_PAPS';

    setForm((prev) => ({
      ...prev,
      loadId: chosen.id,
      manifestType,
      scacOrCarrierCode: prev.scacOrCarrierCode || 'BROP',
      commodity: chosen.commodity || prev.commodity,
      weightKg: chosen.weightLbs ? String(Math.round(chosen.weightLbs * 0.453592)) : prev.weightKg,
      currency: chosen.currency,
      isFoodFda: chosen.isFoodFda,
      vin: trc?.vin || prev.vin,
      plate: trc?.plate || prev.plate,
      jurisdiction: trc?.jurisdiction || prev.jurisdiction,
      fastCardNumber: drv?.fastCardNumber || prev.fastCardNumber,
      driverFirstName: nameParts[0] || prev.driverFirstName,
      driverLastName: nameParts.slice(1).join(' ') || prev.driverLastName,
    }));
  };

  const handleLoadSampleManifest = () => {
    const firstLoad = loads[0];
    setForm({
      loadId: firstLoad?.id ?? '',
      manifestType: 'ACE_PAPS',
      scacOrCarrierCode: 'BROP',
      controlNumber: 'BROP2026994801',
      tripNumber: 'BROPTRIP9948',
      portCode: '0115',
      etaUtc: defaultEtaIso(3),
      vin: '1HTMMAAL43H561234',
      plate: 'PE9948',
      jurisdiction: 'PE',
      fastCardNumber: '980012345',
      driverFirstName: 'Liam',
      driverLastName: 'Gallant',
      driverDob: '1988-05-14',
      carmIorAccountVerified: true,
      carmImporterBnRm: '719283410RM0001',
      isFoodFda: true,
      fdaPriorNoticeNumber: 'FDA-PN-88439210',
      overweightPermitNumber: '',
      commodity: 'Chilled PEI Potatoes & Atlantic Seafood',
      hsCode: '070190',
      countryOfOrigin: 'CA',
      cusmaCertOnFile: true,
      invoiceValueDollars: '42500.00',
      currency: 'CAD',
      weightKg: '17418',
      quantity: '24',
      packageType: 'Pallets',
      shipperName: 'Atlantic Harvest Cold Storage Co.',
      shipperAddress: '100 Harvest Rd, Summerside, PE C1N 4J8',
      consigneeName: 'New England Fresh Market Hub',
      consigneeAddress: '45 Terminal Way, Boston, MA 02210',
    });
  };

  const vinTrimmed = form.vin.trim().toUpperCase();
  const vinIsValid = vinTrimmed.length === 17 && validateVin(vinTrimmed);

  const handleSubmitManifest = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitBusy(true);
    setBanner(null);

    const invoiceValueCents = Math.max(100, Math.round(Number(form.invoiceValueDollars) * 100));
    const weightKg = Number(form.weightKg);
    const quantity = Math.max(1, Math.round(Number(form.quantity)));

    const payload = {
      loadId: form.loadId.trim() || undefined,
      manifestType: form.manifestType,
      scacOrCarrierCode: form.scacOrCarrierCode.trim().toUpperCase(),
      controlNumber: form.controlNumber.trim().toUpperCase(),
      tripNumber: form.tripNumber.trim().toUpperCase(),
      portCode: form.portCode,
      etaUtc: form.etaUtc,
      conveyance: {
        vin: vinTrimmed,
        plate: form.plate.trim().toUpperCase(),
        jurisdiction: form.jurisdiction.trim().toUpperCase(),
      },
      crew: [
        {
          fastCardNumber: form.fastCardNumber.trim(),
          firstName: form.driverFirstName.trim(),
          lastName: form.driverLastName.trim(),
          dateOfBirth: form.driverDob.trim(),
        },
      ],
      carmIorAccountVerified: form.carmIorAccountVerified,
      carmImporterBnRm: form.carmImporterBnRm.trim() || undefined,
      fdaPriorNoticeNumber: form.fdaPriorNoticeNumber.trim() || undefined,
      overweightPermitNumber: form.overweightPermitNumber.trim() || undefined,
      shipments: [
        {
          commodity: form.commodity.trim(),
          hsCode: form.hsCode.trim(),
          countryOfOrigin: form.countryOfOrigin,
          cusmaCertOnFile: form.cusmaCertOnFile,
          invoiceValueCents,
          currency: form.currency,
          weightKg: Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 1000,
          quantity,
          packageType: form.packageType.trim() || 'Pallets',
          isFoodFda: form.isFoodFda,
          shipperName: form.shipperName.trim(),
          shipperAddress: form.shipperAddress.trim(),
          consigneeName: form.consigneeName.trim(),
          consigneeAddress: form.consigneeAddress.trim(),
        },
      ],
    };

    try {
      const res = await fetch('/api/ops/customs/manifests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        report?: CustomsValidationReport;
        coverSheetUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.id || !data.report) {
        setBanner({ kind: 'error', text: data.error || `Manifest filing failed (HTTP ${res.status}).` });
      } else {
        setLatestFiling({
          id: data.id,
          report: data.report,
          coverSheetUrl: data.coverSheetUrl || `/api/ops/customs/manifests/${data.id}/cover-sheet.pdf`,
        });
        setBanner({
          kind: data.report.compliant ? 'success' : 'error',
          text: data.report.compliant
            ? `Manifest ${form.controlNumber.toUpperCase()} PASSED all 2026 CBP/CBSA checks & Code-128 Cover Sheet archived in R2.`
            : `Manifest saved as DRAFT with ${data.report.errors.length} compliance error(s). Inspect validation report below.`,
        });
        await fetchData();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Network error submitting customs manifest.' });
    } finally {
      setSubmitBusy(false);
    }
  };

  const portStatusStyle = (st: PortWaitSnapshot['status']) => {
    switch (st) {
      case 'open':
        return 'bg-emerald-950/70 text-emerald-200 border-emerald-400/45';
      case 'delayed':
        return 'bg-bro-gold/15 text-bro-gold border-bro-gold/45';
      case 'congested':
        return 'bg-rose-950/70 text-rose-200 border-rose-400/50';
      default:
        return 'bg-slate-800 text-slate-300 border-slate-600';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-bro-cyan">
            2026 CBP ACE PAPS · CBSA ACI PARS · CARM Release 2
          </p>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
            Cross-Border Customs &amp; Border Wait Desk
          </h1>
        </div>
        <button
          type="button"
          disabled={refreshingBorders}
          onClick={() => void fetchData(true)}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-bro-cyan/50 text-xs font-semibold text-white cursor-pointer disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${refreshingBorders ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>Sync CBP / CBSA Feeds</span>
        </button>
      </div>

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

      {/* Live CBP & CBSA Commercial Border Wait Times Table */}
      <section aria-label="Live CBP and CBSA Commercial Border Wait Times" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-3 bg-[#0b1120]">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Live CBP &amp; CBSA Commercial Border Wait Times
            </h2>
          </div>
          {borderFeed && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`px-3 py-1 rounded-full border font-medium ${
                  borderFeed.sources.cbsa.ok
                    ? 'bg-emerald-950/60 border-emerald-400/40 text-emerald-200'
                    : 'bg-rose-950/60 border-rose-400/50 text-rose-200'
                }`}
              >
                CBSA CSV: {borderFeed.sources.cbsa.ok ? `${borderFeed.sources.cbsa.recordCount} pts` : 'Offline'}
              </span>
              <span
                className={`px-3 py-1 rounded-full border font-medium ${
                  borderFeed.sources.cbp.ok
                    ? 'bg-emerald-950/60 border-emerald-400/40 text-emerald-200'
                    : 'bg-rose-950/60 border-rose-400/50 text-rose-200'
                }`}
              >
                CBP XML: {borderFeed.sources.cbp.ok ? `${borderFeed.sources.cbp.recordCount} pts` : 'Offline'}
              </span>
              {borderFeed.stale && (
                <span className="px-3 py-1 rounded-full bg-bro-gold/15 border border-bro-gold/40 text-bro-gold font-medium">
                  Cached / Partial Feed
                </span>
              )}
              <span className="text-slate-300 tabular-nums font-mono">
                Synced: {new Date(borderFeed.fetchedAt).toISOString().slice(11, 19)} UTC
              </span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Port Code</th>
                <th className="px-4 py-3">Crossing &amp; Corridor</th>
                <th className="px-4 py-3 text-right">Northbound (CBSA)</th>
                <th className="px-4 py-3 text-right">Southbound (CBP)</th>
                <th className="px-4 py-3 text-right">FAST Lane</th>
                <th className="px-4 py-3 text-right">Open Lanes</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {!borderFeed ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-300">
                    {loading ? 'Querying official CBP XML & CBSA CSV wait feeds...' : 'Border telemetry unavailable.'}
                  </td>
                </tr>
              ) : (
                borderFeed.ports.map((p) => (
                  <tr key={p.cbpCode} className="hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-mono font-bold text-bro-cyan whitespace-nowrap tabular-nums">
                      {p.cbpCode}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-white">{p.crossingName}</div>
                      <div className="text-xs text-slate-400">
                        {p.cbsaName} · {p.highway}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                      {formatWait(p.northboundCommercialMinutes)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                      {formatWait(p.southboundCommercialMinutes)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-bro-cyan whitespace-nowrap">
                      {p.commercialFastLane ? formatWait(p.southboundFastMinutes) : 'No FAST'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-300">
                      {p.commercialLanesOpen ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2.5 py-1 rounded-full border text-xs uppercase font-semibold ${portStatusStyle(p.status)}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, portCode: p.cbpCode }))}
                        className={`px-3.5 py-1.5 min-h-[40px] rounded-xl border text-xs font-semibold cursor-pointer transition-colors ${
                          form.portCode === p.cbpCode
                            ? 'bg-bro-cyan/20 border-bro-cyan text-bro-cyan'
                            : 'bg-[#0b1120] border-white/15 text-slate-200 hover:text-white hover:border-white/30'
                        }`}
                      >
                        {form.portCode === p.cbpCode ? 'Selected' : 'Use Port'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ACE PAPS / ACI PARS Manifest Builder + Validation Report */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Builder Form */}
        <section aria-label="ACE PAPS and ACI PARS Manifest Builder" className="xl:col-span-7 surface-ceramic rounded-2xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div className="flex items-center gap-2">
              <FileCheck2 className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base font-bold text-white">
                ACE PAPS / ACI PARS Manifest Builder
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleLoadSampleManifest}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-xl bg-bro-gold/15 border border-bro-gold/40 hover:bg-bro-gold/25 text-xs font-semibold text-bro-gold cursor-pointer transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Load Sample Manifest</span>
              </button>
              <button
                type="button"
                onClick={() => setForm(createEmptyCustomsForm())}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-xl bg-[#0b1120] border border-white/15 hover:border-white/30 text-xs font-medium text-slate-300 hover:text-white cursor-pointer transition-colors"
              >
                <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Clear</span>
              </button>
            </div>
          </div>

          <div
            role="group"
            aria-label="Manifest corridor type"
            className="inline-flex flex-wrap rounded-2xl sm:rounded-full border border-white/10 bg-[#060912] p-1 gap-1"
          >
            {(['ACE_PAPS', 'ACI_PARS'] as const).map((mt) => (
              <button
                key={mt}
                type="button"
                aria-pressed={form.manifestType === mt}
                onClick={() => setForm((prev) => ({ ...prev, manifestType: mt }))}
                className={`px-4 py-2 min-h-[40px] rounded-xl sm:rounded-full text-xs font-semibold cursor-pointer transition-colors ${
                  form.manifestType === mt
                    ? 'bg-bro-gold text-bro-obsidian font-bold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {mt === 'ACE_PAPS' ? 'ACE PAPS (CA → US)' : 'ACI PARS (US → CA)'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmitManifest} className="space-y-4">
            {/* Control Identifiers & Port */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label htmlFor="customs-scac" className="block text-xs font-medium text-slate-300 mb-1.5">
                  SCAC / Carrier Code
                </label>
                <input
                  id="customs-scac"
                  type="text"
                  required
                  maxLength={4}
                  placeholder="BROP"
                  value={form.scacOrCarrierCode}
                  onChange={(e) => setForm({ ...form, scacOrCarrierCode: e.target.value.toUpperCase() })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                />
              </div>
              <div>
                <label htmlFor="customs-control-num" className="block text-xs font-medium text-slate-300 mb-1.5">
                  {form.manifestType === 'ACE_PAPS' ? 'PAPS Control #' : 'PARS Control #'}
                </label>
                <input
                  id="customs-control-num"
                  type="text"
                  required
                  placeholder="BROP2026994801"
                  value={form.controlNumber}
                  onChange={(e) => setForm({ ...form, controlNumber: e.target.value.toUpperCase() })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                />
              </div>
              <div>
                <label htmlFor="customs-trip-num" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Trip Number
                </label>
                <input
                  id="customs-trip-num"
                  type="text"
                  required
                  placeholder="BROPTRIP9948"
                  value={form.tripNumber}
                  onChange={(e) => setForm({ ...form, tripNumber: e.target.value.toUpperCase() })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                />
              </div>
              <div>
                <label htmlFor="customs-load-id" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Linked Load (Optional)
                </label>
                {loads.length > 0 ? (
                  <select
                    id="customs-load-id"
                    value={form.loadId}
                    onChange={(e) => handleSelectExistingLoad(e.target.value)}
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white outline-none"
                  >
                    <option value="">-- Unlinked / Custom --</option>
                    {loads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.loadNumber} — {l.commodity}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="customs-load-id"
                    type="text"
                    value={form.loadId}
                    onChange={(e) => setForm({ ...form, loadId: e.target.value })}
                    placeholder="Optional load ID"
                    className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="customs-port-code" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Commercial Port of Entry
                </label>
                <select
                  id="customs-port-code"
                  value={form.portCode}
                  onChange={(e) => setForm({ ...form, portCode: e.target.value })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white outline-none"
                >
                  {NORTH_AMERICAN_PORTS.map((p) => (
                    <option key={p.cbpCode} value={p.cbpCode}>
                      {p.cbpCode} — {p.crossingName} ({p.highway})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5 gap-2">
                  <label htmlFor="customs-eta-utc" className="text-xs font-medium text-slate-300">
                    Border ETA (UTC)
                  </label>
                  <div className="flex items-center gap-1.5">
                    {[2, 3, 6].map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setForm({ ...form, etaUtc: defaultEtaIso(h) })}
                        className="px-2.5 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-xs font-mono text-bro-cyan cursor-pointer transition-colors"
                      >
                        +{h}h
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  id="customs-eta-utc"
                  type="datetime-local"
                  required
                  value={toDatetimeLocalValue(form.etaUtc)}
                  onChange={(e) => {
                    if (e.target.value) {
                      setForm({ ...form, etaUtc: new Date(`${e.target.value}:00.000Z`).toISOString() });
                    }
                  }}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums outline-none"
                />
              </div>
            </div>

            {/* Conveyance ISO 3779 VIN & Crew FAST */}
            <div className="p-4 rounded-2xl bg-[#0b1120] border border-white/10 space-y-3.5">
              <div className="text-xs font-bold uppercase tracking-wide text-bro-cyan">
                Conveyance (ISO 3779 Check-Digit) &amp; Crew FAST Credentials
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label htmlFor="customs-vin" className="text-xs font-medium text-slate-300">
                      17-Char Tractor VIN
                    </label>
                    <span
                      className={`font-mono text-xs font-semibold ${
                        vinTrimmed.length === 0
                          ? 'text-slate-400'
                          : vinTrimmed.length < 17
                            ? 'text-bro-gold'
                            : vinIsValid
                              ? 'text-emerald-300'
                              : 'text-rose-300'
                      }`}
                    >
                      {vinTrimmed.length === 0
                        ? 'ISO 3779'
                        : vinTrimmed.length < 17
                          ? `${vinTrimmed.length}/17 chars`
                          : vinIsValid
                            ? 'ISO 3779 Valid'
                            : 'Invalid Check Digit'}
                    </span>
                  </div>
                  <input
                    id="customs-vin"
                    type="text"
                    required
                    maxLength={17}
                    placeholder="1HTMMAAL43H561234"
                    value={form.vin}
                    onChange={(e) => setForm({ ...form, vin: e.target.value.toUpperCase() })}
                    className={`w-full rounded-xl bg-[#070b16] border px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none ${
                      vinTrimmed.length === 0
                        ? 'border-white/15 focus:border-bro-cyan'
                        : vinIsValid
                          ? 'border-emerald-400/50'
                          : 'border-rose-400/60'
                    }`}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label htmlFor="customs-plate" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Plate
                    </label>
                    <input
                      id="customs-plate"
                      type="text"
                      required
                      placeholder="PE9948"
                      value={form.plate}
                      onChange={(e) => setForm({ ...form, plate: e.target.value.toUpperCase() })}
                      className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="customs-jur" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Jur
                    </label>
                    <input
                      id="customs-jur"
                      type="text"
                      required
                      maxLength={2}
                      placeholder="PE"
                      value={form.jurisdiction}
                      onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase() })}
                      className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="customs-fast" className="block text-xs font-medium text-slate-300 mb-1.5">
                    FAST Card (9 digits)
                  </label>
                  <input
                    id="customs-fast"
                    type="text"
                    required
                    placeholder="980012345"
                    value={form.fastCardNumber}
                    onChange={(e) => setForm({ ...form, fastCardNumber: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="customs-drv-first" className="block text-xs font-medium text-slate-300 mb-1.5">
                    First Name
                  </label>
                  <input
                    id="customs-drv-first"
                    type="text"
                    required
                    placeholder="Driver first name"
                    value={form.driverFirstName}
                    onChange={(e) => setForm({ ...form, driverFirstName: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="customs-drv-last" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Last Name
                  </label>
                  <input
                    id="customs-drv-last"
                    type="text"
                    required
                    placeholder="Driver last name"
                    value={form.driverLastName}
                    onChange={(e) => setForm({ ...form, driverLastName: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="customs-drv-dob" className="block text-xs font-medium text-slate-300 mb-1.5">
                    DOB (YYYY-MM-DD)
                  </label>
                  <input
                    id="customs-drv-dob"
                    type="text"
                    required
                    placeholder="1988-05-14"
                    value={form.driverDob}
                    onChange={(e) => setForm({ ...form, driverDob: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                  />
                </div>
              </div>
            </div>

            {/* CARM Release 2 & FDA 2-Hr Prior Notice Gates */}
            <div className="p-4 rounded-2xl bg-[#0b1120] border border-bro-gold/25 space-y-3.5">
              <div className="text-xs font-bold uppercase tracking-wide text-bro-gold">
                2026 Regulatory Gates: CBSA CARM Release 2 &amp; FDA 2-Hour Prior Notice
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="customs-carm-verified" className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer min-h-[32px]">
                    <input
                      id="customs-carm-verified"
                      type="checkbox"
                      checked={form.carmIorAccountVerified}
                      onChange={(e) => setForm({ ...form, carmIorAccountVerified: e.target.checked })}
                      className="w-4 h-4 rounded border-white/25 accent-cyan-400 cursor-pointer"
                    />
                    <span>CARM Release 2 IOR RPP Bond Verified</span>
                  </label>
                  <div>
                    <label htmlFor="customs-carm-bn" className="sr-only">
                      CRA BN/RM Account
                    </label>
                    <input
                      id="customs-carm-bn"
                      type="text"
                      value={form.carmImporterBnRm}
                      onChange={(e) => setForm({ ...form, carmImporterBnRm: e.target.value.toUpperCase() })}
                      placeholder="CRA BN/RM Account (e.g. 719283410RM0001)"
                      className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="customs-fda-flag" className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer min-h-[32px]">
                    <input
                      id="customs-fda-flag"
                      type="checkbox"
                      checked={form.isFoodFda}
                      onChange={(e) => setForm({ ...form, isFoodFda: e.target.checked })}
                      className="w-4 h-4 rounded border-white/25 accent-amber-400 cursor-pointer"
                    />
                    <span>Perishable / FDA Food Commodity (2-Hr Window)</span>
                  </label>
                  <div>
                    <label htmlFor="customs-fda-pn" className="sr-only">
                      FDA 2-Hour Prior Notice Confirmation Number
                    </label>
                    <input
                      id="customs-fda-pn"
                      type="text"
                      value={form.fdaPriorNoticeNumber}
                      onChange={(e) => setForm({ ...form, fdaPriorNoticeNumber: e.target.value.toUpperCase() })}
                      placeholder="FDA 2-Hr Prior Notice Confirmation #"
                      className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white uppercase placeholder:text-slate-400 outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Shipment Commodity, HS Code, Weight kg, Parties */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="customs-commodity" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Commodity Description
                </label>
                <input
                  id="customs-commodity"
                  type="text"
                  required
                  placeholder="Commercial freight commodity"
                  value={form.commodity}
                  onChange={(e) => setForm({ ...form, commodity: e.target.value })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                />
              </div>
              <div>
                <label htmlFor="customs-hscode" className="block text-xs font-medium text-slate-300 mb-1.5">
                  HS / HTS Code (6–10 digits)
                </label>
                <input
                  id="customs-hscode"
                  type="text"
                  required
                  placeholder="070190"
                  value={form.hsCode}
                  onChange={(e) => setForm({ ...form, hsCode: e.target.value.replace(/\D/g, '') })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                />
              </div>
              <div>
                <label htmlFor="customs-weight-kg" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Weight (kg, max 36,287)
                </label>
                <input
                  id="customs-weight-kg"
                  type="number"
                  required
                  min={1}
                  step="0.1"
                  placeholder="17418"
                  value={form.weightKg}
                  onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                />
              </div>

              <div>
                <label htmlFor="customs-origin" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Origin Country
                </label>
                <select
                  id="customs-origin"
                  value={form.countryOfOrigin}
                  onChange={(e) => setForm({ ...form, countryOfOrigin: e.target.value as 'CA' | 'US' | 'MX' | 'OTHER' })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white outline-none"
                >
                  <option value="CA">CA — Canada</option>
                  <option value="US">US — United States</option>
                  <option value="MX">MX — Mexico</option>
                  <option value="OTHER">OTHER (Non-CUSMA)</option>
                </select>
              </div>
              <div>
                <label htmlFor="customs-invoice-val" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Invoice Value ($)
                </label>
                <input
                  id="customs-invoice-val"
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  placeholder="42500.00"
                  value={form.invoiceValueDollars}
                  onChange={(e) => setForm({ ...form, invoiceValueDollars: e.target.value })}
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                />
              </div>
              <div>
                <label htmlFor="customs-currency" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Currency &amp; Qty
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    id="customs-currency"
                    aria-label="Invoice Currency"
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value as 'CAD' | 'USD' })}
                    className="rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-2.5 py-2 min-h-[40px] font-mono text-xs text-white outline-none"
                  >
                    <option value="CAD">CAD</option>
                    <option value="USD">USD</option>
                  </select>
                  <input
                    id="customs-qty"
                    aria-label="Package Quantity"
                    type="number"
                    required
                    min={1}
                    placeholder="24"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                    className="rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-2.5 py-2 min-h-[40px] font-mono text-xs text-white tabular-nums placeholder:text-slate-400 outline-none"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="customs-permit" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Overweight Permit #
                </label>
                <input
                  id="customs-permit"
                  type="text"
                  value={form.overweightPermitNumber}
                  onChange={(e) => setForm({ ...form, overweightPermitNumber: e.target.value })}
                  placeholder="Optional if >36,287kg"
                  className="w-full rounded-xl bg-[#0b1120] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] font-mono text-xs text-white placeholder:text-slate-400 outline-none"
                />
              </div>
            </div>

            {/* Shipper & Consignee Parties */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="p-3.5 rounded-2xl bg-[#0b1120] border border-white/10 space-y-2.5">
                <div className="text-xs font-semibold text-bro-cyan">Exporter / Shipper Party</div>
                <div>
                  <label htmlFor="customs-shipper-name" className="block text-xs font-medium text-slate-300 mb-1">
                    Shipper Legal Name
                  </label>
                  <input
                    id="customs-shipper-name"
                    type="text"
                    required
                    placeholder="Shipper company name"
                    value={form.shipperName}
                    onChange={(e) => setForm({ ...form, shipperName: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="customs-shipper-addr" className="block text-xs font-medium text-slate-300 mb-1">
                    Shipper Address
                  </label>
                  <input
                    id="customs-shipper-addr"
                    type="text"
                    required
                    placeholder="Street, City, Prov/State, Postal"
                    value={form.shipperAddress}
                    onChange={(e) => setForm({ ...form, shipperAddress: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#0b1120] border border-white/10 space-y-2.5">
                <div className="text-xs font-semibold text-bro-gold">Importer / Consignee Party</div>
                <div>
                  <label htmlFor="customs-consignee-name" className="block text-xs font-medium text-slate-300 mb-1">
                    Consignee Legal Name
                  </label>
                  <input
                    id="customs-consignee-name"
                    type="text"
                    required
                    placeholder="Consignee company name"
                    value={form.consigneeName}
                    onChange={(e) => setForm({ ...form, consigneeName: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="customs-consignee-addr" className="block text-xs font-medium text-slate-300 mb-1">
                    Consignee Address
                  </label>
                  <input
                    id="customs-consignee-addr"
                    type="text"
                    required
                    placeholder="Street, City, State/Prov, ZIP"
                    value={form.consigneeAddress}
                    onChange={(e) => setForm({ ...form, consigneeAddress: e.target.value })}
                    className="w-full rounded-xl bg-[#070b16] border border-white/15 focus:border-bro-cyan px-3 py-2 min-h-[40px] text-xs text-white placeholder:text-slate-400 outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-3 pt-3 border-t border-white/10">
              <label htmlFor="customs-cusma" className="inline-flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer min-h-[36px]">
                <input
                  id="customs-cusma"
                  type="checkbox"
                  checked={form.cusmaCertOnFile}
                  onChange={(e) => setForm({ ...form, cusmaCertOnFile: e.target.checked })}
                  className="w-4 h-4 rounded border-white/25 accent-cyan-400 cursor-pointer"
                />
                <span>CUSMA / USMCA Certificate of Origin On File</span>
              </label>

              <button
                type="submit"
                disabled={submitBusy}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-bro-cyan text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                <span>{submitBusy ? 'Validating & Archiving...' : 'Validate & Generate Code-128 Cover Sheet'}</span>
              </button>
            </div>
          </form>
        </section>

        {/* Right Panel: Deterministic Validation Report */}
        <section aria-label="Customs Compliance Validation Report" className="xl:col-span-5 surface-ceramic rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h2 className="font-display text-base font-bold text-white">
              Deterministic Pre-Flight Validation Report
            </h2>
            {latestFiling && (
              <span
                className={`px-3 py-1 rounded-full border text-xs font-bold uppercase ${
                  latestFiling.report.compliant
                    ? 'bg-emerald-950/70 border-emerald-400/50 text-emerald-200'
                    : 'bg-rose-950/70 border-rose-400/50 text-rose-200'
                }`}
              >
                {latestFiling.report.compliant ? 'Compliant' : 'Blocked'}
              </span>
            )}
          </div>

          {!latestFiling ? (
            <div className="py-12 text-center text-xs text-slate-300 space-y-2.5">
              <FileCheck2 className="w-7 h-7 text-bro-gold mx-auto" aria-hidden="true" />
              <p>Submit the ACE PAPS / ACI PARS builder to run all 9 deterministic customs gates.</p>
              <p className="text-xs text-slate-400 leading-relaxed">
                Verifies Carrier Prefix, ISO 3779 VIN, FAST credentials, Pre-Arrival Lead Time, FDA 2-Hr Notice, CARM Release 2 IOR RPP bond, CUSMA surtax warnings &amp; GVW limits.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${
                  latestFiling.report.compliant
                    ? 'bg-emerald-950/45 border-emerald-400/45'
                    : 'bg-rose-950/45 border-rose-400/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  {latestFiling.report.compliant ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-300 shrink-0" aria-hidden="true" />
                  ) : (
                    <ShieldX className="w-5 h-5 text-rose-300 shrink-0" aria-hidden="true" />
                  )}
                  <div className="text-xs">
                    <div className="font-mono font-bold text-white">{latestFiling.report.manifestId}</div>
                    <div className="text-slate-300 mt-0.5">
                      {latestFiling.report.portName} · Lead Time: {latestFiling.report.leadTimeMinutes}m (req {latestFiling.report.requiredLeadTimeMinutes}m)
                    </div>
                  </div>
                </div>
              </div>

              <a
                href={latestFiling.coverSheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-bro-gold text-bro-obsidian text-xs font-bold uppercase tracking-wider hover:bg-amber-400 transition-colors"
              >
                <Download className="w-4 h-4" aria-hidden="true" />
                <span>Download Code-128 Cover Sheet PDF</span>
              </a>

              {/* Individual Checks */}
              <div className="space-y-2">
                {latestFiling.report.checks.map((chk) => (
                  <div
                    key={chk.code}
                    className="p-3 rounded-xl bg-[#0b1120] border border-white/10 flex items-start justify-between gap-2 text-xs"
                  >
                    <div>
                      <div className="text-white font-semibold">{chk.label}</div>
                      <div className="text-slate-300 mt-0.5">{chk.detail}</div>
                    </div>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs uppercase font-bold shrink-0 border ${
                        chk.status === 'pass'
                          ? 'bg-emerald-950/70 text-emerald-200 border-emerald-400/45'
                          : chk.status === 'warn'
                            ? 'bg-bro-gold/15 text-bro-gold border-bro-gold/40'
                            : 'bg-rose-950/70 text-rose-200 border-rose-400/50'
                      }`}
                    >
                      {chk.status}
                    </span>
                  </div>
                ))}
              </div>

              {latestFiling.report.warnings.length > 0 && (
                <div className="p-3.5 rounded-xl bg-bro-gold/10 border border-bro-gold/35 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase text-bro-gold">
                    <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>Tariff / Regulatory Warnings</span>
                  </div>
                  {latestFiling.report.warnings.map((w, idx) => (
                    <p key={idx} className="text-xs text-amber-100">{w}</p>
                  ))}
                </div>
              )}

              {latestFiling.report.errors.length > 0 && (
                <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-400/50 space-y-1.5">
                  <div className="text-xs font-bold uppercase text-rose-200">
                    Blocking Compliance Failures
                  </div>
                  {latestFiling.report.errors.map((err, idx) => (
                    <p key={idx} className="text-xs text-rose-100">{err}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Persisted Customs Manifests Registry */}
      <section aria-label="Filed and Draft Customs Manifests" className="surface-ceramic rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-bro-cyan shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-white">
              Filed &amp; RNS-Tracked Manifests ({manifests.length})
            </h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-[#0b1120] text-xs font-medium text-slate-300">
                <th className="px-4 py-3">Control #</th>
                <th className="px-4 py-3">Type / Port</th>
                <th className="px-4 py-3">ETA (UTC)</th>
                <th className="px-4 py-3">CARM / FDA</th>
                <th className="px-4 py-3">RNS Status</th>
                <th className="px-4 py-3 text-right">Cover Sheet PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs font-mono">
              {manifests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center font-sans text-slate-300">
                    No customs manifests filed yet.
                  </td>
                </tr>
              ) : (
                manifests.map((m) => (
                  <tr key={m.id} className="hover:bg-white/[0.03]">
                    <td className="px-4 py-3.5">
                      <div className="font-bold text-white">{m.controlNumber}</div>
                      <div className="text-xs text-slate-400">
                        Trip: {m.tripNumber} {m.loadId ? `· ${m.loadId}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="text-bro-gold font-bold">{m.manifestType}</span>
                      <div className="text-xs text-slate-400">Port {m.portCode}</div>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300 tabular-nums whitespace-nowrap">
                      {m.etaUtc.slice(0, 16).replace('T', ' ')}Z
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        <span
                          className={`px-2.5 py-0.5 rounded-full border ${
                            m.carmIorVerified
                              ? 'bg-emerald-950/60 border-emerald-400/40 text-emerald-200'
                              : 'bg-slate-800 border-slate-600 text-slate-300'
                          }`}
                        >
                          CARM {m.carmIorVerified ? 'OK' : 'UNVER'}
                        </span>
                        {m.fdaPriorNoticeNum && (
                          <span className="px-2.5 py-0.5 rounded-full bg-bro-cyan/15 border border-bro-cyan/40 text-bro-cyan">
                            FDA: {m.fdaPriorNoticeNum}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <span
                        className={`px-2.5 py-1 rounded-full border text-xs uppercase font-semibold ${
                          m.status === 'released'
                            ? 'bg-emerald-950/70 border-emerald-400/50 text-emerald-200'
                            : m.status === 'held'
                              ? 'bg-rose-950/70 border-rose-400/50 text-rose-200'
                              : m.status === 'filed'
                                ? 'bg-bro-cyan/15 border-bro-cyan/40 text-bro-cyan'
                                : 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold'
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      <a
                        href={`/api/ops/customs/manifests/${encodeURIComponent(m.id)}/cover-sheet.pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[44px] sm:min-h-[40px] rounded-xl bg-[#0b1120] hover:bg-slate-800 border border-white/15 text-xs text-bro-cyan font-semibold transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Code-128 PDF</span>
                      </a>
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
