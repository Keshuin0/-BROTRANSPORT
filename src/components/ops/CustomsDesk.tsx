import { useState, useEffect, useCallback, type SyntheticEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileCheck2,
  Globe,
  RefreshCw,
  ShieldCheck,
  ShieldX,
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

export default function CustomsDesk() {
  const [borderFeed, setBorderFeed] = useState<BorderWaitFeed | null>(null);
  const [manifests, setManifests] = useState<CustomsManifestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingBorders, setRefreshingBorders] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [latestFiling, setLatestFiling] = useState<{
    id: string;
    report: CustomsValidationReport;
    coverSheetUrl: string;
  } | null>(null);

  const [form, setForm] = useState({
    loadId: 'load_9948',
    manifestType: 'ACE_PAPS' as CustomsManifestType,
    scacOrCarrierCode: 'BROP',
    controlNumber: 'BROP2026994801',
    tripNumber: 'BROPTRIP9948',
    portCode: '0115',
    etaUtc: defaultEtaIso(3),
    vin: '1HGCM82633A004352',
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
    countryOfOrigin: 'CA' as 'CA' | 'US' | 'MX' | 'OTHER',
    cusmaCertOnFile: true,
    invoiceValueDollars: '42500.00',
    currency: 'CAD' as 'CAD' | 'USD',
    weightKg: '17418',
    quantity: '24',
    packageType: 'Pallets',
    shipperName: 'Cavendish Valley Produce Co.',
    shipperAddress: '100 Harvest Rd, Summerside, PE C1N 4J8',
    consigneeName: 'New England Fresh Market Hub',
    consigneeAddress: '45 Terminal Way, Boston, MA 02210',
  });

  const fetchData = useCallback(async (isBorderRefresh = false) => {
    if (isBorderRefresh) setRefreshingBorders(true);
    try {
      const [borderRes, manRes] = await Promise.all([
        fetch('/api/borders/wait-times'),
        fetch('/api/ops/customs/manifests'),
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

  const vinIsValid = validateVin(form.vin);

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
        vin: form.vin.trim().toUpperCase(),
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
          packageType: form.packageType.trim(),
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
        return 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40';
      case 'delayed':
        return 'bg-bro-gold/15 text-bro-gold border-bro-gold/45';
      case 'congested':
        return 'bg-bro-crimson/15 text-bro-crimson border-bro-crimson/45';
      default:
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-bro-cyan">
            MODULE 03 // 2026 CBP ACE PAPS · CBSA ACI PARS · CARM RELEASE 2
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-0.5">
            Cross-Border Customs &amp; Border Wait Desk
          </h1>
        </div>
        <button
          type="button"
          disabled={refreshingBorders}
          onClick={() => void fetchData(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-bro-steel border border-white/15 hover:border-bro-cyan/50 font-mono text-xs text-white cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshingBorders ? 'animate-spin' : ''}`} />
          Sync CBP / CBSA Feeds
        </button>
      </div>

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

      {/* Live CBP & CBSA Commercial Border Wait Times Table */}
      <section aria-label="Live CBP and CBSA Commercial Border Wait Times" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3 bg-bro-obsidian/60">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-bro-cyan" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Live CBP &amp; CBSA Commercial Border Wait Times
            </h2>
          </div>
          {borderFeed && (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
              <span
                className={`px-2 py-0.5 rounded border ${
                  borderFeed.sources.cbsa.ok
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/60 border-bro-crimson/40 text-rose-200'
                }`}
              >
                CBSA CSV: {borderFeed.sources.cbsa.ok ? `${borderFeed.sources.cbsa.recordCount} pts` : 'OFFLINE'}
              </span>
              <span
                className={`px-2 py-0.5 rounded border ${
                  borderFeed.sources.cbp.ok
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/60 border-bro-crimson/40 text-rose-200'
                }`}
              >
                CBP XML: {borderFeed.sources.cbp.ok ? `${borderFeed.sources.cbp.recordCount} pts` : 'OFFLINE'}
              </span>
              {borderFeed.stale && (
                <span className="px-2 py-0.5 rounded bg-bro-gold/15 border border-bro-gold/40 text-bro-gold">
                  CACHED / PARTIAL FEED
                </span>
              )}
              <span className="text-slate-400 tabular-nums">
                Synced: {new Date(borderFeed.fetchedAt).toISOString().slice(11, 19)} UTC
              </span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">Port Code</th>
                <th className="px-4 py-2.5">Crossing &amp; Corridor</th>
                <th className="px-4 py-2.5 text-right">Northbound (CBSA)</th>
                <th className="px-4 py-2.5 text-right">Southbound (CBP)</th>
                <th className="px-4 py-2.5 text-right">FAST Lane</th>
                <th className="px-4 py-2.5 text-right">Open Lanes</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs">
              {!borderFeed ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center font-mono text-slate-500">
                    {loading ? 'Querying official CBP XML & CBSA CSV wait feeds...' : 'Border telemetry unavailable.'}
                  </td>
                </tr>
              ) : (
                borderFeed.ports.map((p) => (
                  <tr key={p.cbpCode} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 font-mono font-bold text-bro-cyan whitespace-nowrap tabular-nums">
                      {p.cbpCode}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-white font-medium">{p.crossingName}</div>
                      <div className="font-mono text-[10px] text-slate-400">
                        {p.cbsaName} · {p.highway}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                      {formatWait(p.northboundCommercialMinutes)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                      {formatWait(p.southboundCommercialMinutes)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-bro-cyan whitespace-nowrap">
                      {p.commercialFastLane ? formatWait(p.southboundFastMinutes) : 'No FAST'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {p.commercialLanesOpen ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded border font-mono text-[10px] uppercase font-bold ${portStatusStyle(p.status)}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, portCode: p.cbpCode }))}
                        className={`px-2.5 py-1 rounded border font-mono text-[10px] uppercase cursor-pointer ${
                          form.portCode === p.cbpCode
                            ? 'bg-bro-cyan/20 border-bro-cyan text-bro-cyan font-bold'
                            : 'bg-bro-steel border-white/15 text-slate-300 hover:text-white'
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
        <section aria-label="ACE PAPS and ACI PARS Manifest Builder" className="xl:col-span-7 glass-panel rounded-lg border border-white/10 p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <FileCheck2 className="w-4 h-4 text-bro-gold" />
              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
                ACE PAPS / ACI PARS Manifest Builder
              </h2>
            </div>

            <div className="inline-flex rounded border border-white/15 bg-bro-obsidian p-0.5">
              {(['ACE_PAPS', 'ACI_PARS'] as const).map((mt) => (
                <button
                  key={mt}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, manifestType: mt }))}
                  className={`px-3 py-1 rounded font-mono text-[11px] cursor-pointer ${
                    form.manifestType === mt
                      ? 'bg-bro-gold text-bro-obsidian font-bold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {mt === 'ACE_PAPS' ? 'ACE PAPS (CA -> US)' : 'ACI PARS (US -> CA)'}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmitManifest} className="space-y-4">
            {/* Control Identifiers & Port */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">SCAC / Carrier Code</label>
                <input
                  type="text"
                  required
                  maxLength={4}
                  value={form.scacOrCarrierCode}
                  onChange={(e) => setForm({ ...form, scacOrCarrierCode: e.target.value.toUpperCase() })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white uppercase"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">
                  {form.manifestType === 'ACE_PAPS' ? 'PAPS Control #' : 'PARS Control #'}
                </label>
                <input
                  type="text"
                  required
                  value={form.controlNumber}
                  onChange={(e) => setForm({ ...form, controlNumber: e.target.value.toUpperCase() })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white uppercase"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Trip Number</label>
                <input
                  type="text"
                  required
                  value={form.tripNumber}
                  onChange={(e) => setForm({ ...form, tripNumber: e.target.value.toUpperCase() })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white uppercase"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Linked Load ID</label>
                <input
                  type="text"
                  value={form.loadId}
                  onChange={(e) => setForm({ ...form, loadId: e.target.value })}
                  placeholder="Optional load_..."
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">
                  Commercial Port of Entry (NORTH_AMERICAN_PORTS)
                </label>
                <select
                  value={form.portCode}
                  onChange={(e) => setForm({ ...form, portCode: e.target.value })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-2 font-mono text-xs text-white"
                >
                  {NORTH_AMERICAN_PORTS.map((p) => (
                    <option key={p.cbpCode} value={p.cbpCode}>
                      {p.cbpCode} — {p.crossingName} ({p.highway})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-mono text-[10px] uppercase text-slate-400">Border ETA (UTC)</label>
                  <div className="flex items-center gap-1">
                    {[2, 3, 6].map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setForm({ ...form, etaUtc: defaultEtaIso(h) })}
                        className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 font-mono text-[9px] text-bro-cyan cursor-pointer"
                      >
                        +{h}h
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="datetime-local"
                  required
                  value={toDatetimeLocalValue(form.etaUtc)}
                  onChange={(e) => {
                    if (e.target.value) {
                      setForm({ ...form, etaUtc: new Date(`${e.target.value}:00.000Z`).toISOString() });
                    }
                  }}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white tabular-nums"
                />
              </div>
            </div>

            {/* Conveyance ISO 3779 VIN & Crew FAST */}
            <div className="p-3.5 rounded-lg bg-bro-obsidian/60 border border-white/10 space-y-3">
              <div className="font-mono text-[10px] uppercase font-bold text-bro-cyan">
                Conveyance (ISO 3779 Check-Digit) &amp; Crew FAST Credentials
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-mono text-[10px] uppercase text-slate-400">17-Char Tractor VIN</label>
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        vinIsValid ? 'text-emerald-400' : 'text-bro-crimson'
                      }`}
                    >
                      {vinIsValid ? 'ISO 3779 VALID' : 'INVALID CHECK DIGIT'}
                    </span>
                  </div>
                  <input
                    type="text"
                    required
                    maxLength={17}
                    value={form.vin}
                    onChange={(e) => setForm({ ...form, vin: e.target.value.toUpperCase() })}
                    className={`w-full rounded bg-bro-steel border px-3 py-1.5 font-mono text-xs text-white uppercase outline-none ${
                      vinIsValid ? 'border-emerald-500/40' : 'border-bro-crimson/60'
                    }`}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Plate</label>
                    <input
                      type="text"
                      required
                      value={form.plate}
                      onChange={(e) => setForm({ ...form, plate: e.target.value.toUpperCase() })}
                      className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white uppercase"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Jur</label>
                    <input
                      type="text"
                      required
                      maxLength={2}
                      value={form.jurisdiction}
                      onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase() })}
                      className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white uppercase"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">FAST Card (9 digits)</label>
                  <input
                    type="text"
                    required
                    value={form.fastCardNumber}
                    onChange={(e) => setForm({ ...form, fastCardNumber: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">First Name</label>
                  <input
                    type="text"
                    required
                    value={form.driverFirstName}
                    onChange={(e) => setForm({ ...form, driverFirstName: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Last Name</label>
                  <input
                    type="text"
                    required
                    value={form.driverLastName}
                    onChange={(e) => setForm({ ...form, driverLastName: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">DOB (YYYY-MM-DD)</label>
                  <input
                    type="text"
                    required
                    value={form.driverDob}
                    onChange={(e) => setForm({ ...form, driverDob: e.target.value })}
                    className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white tabular-nums"
                  />
                </div>
              </div>
            </div>

            {/* CARM Release 2 & FDA 2-Hr Prior Notice Gates */}
            <div className="p-3.5 rounded-lg bg-bro-obsidian/60 border border-bro-gold/25 space-y-3">
              <div className="font-mono text-[10px] uppercase font-bold text-bro-gold">
                2026 Regulatory Gates: CBSA CARM Release 2 &amp; FDA 2-Hour Prior Notice
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 font-mono text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.carmIorAccountVerified}
                      onChange={(e) => setForm({ ...form, carmIorAccountVerified: e.target.checked })}
                      className="rounded border-white/20"
                    />
                    CARM Release 2 IOR RPP Bond Verified
                  </label>
                  <input
                    type="text"
                    value={form.carmImporterBnRm}
                    onChange={(e) => setForm({ ...form, carmImporterBnRm: e.target.value.toUpperCase() })}
                    placeholder="CRA BN/RM Account (e.g. 719283410RM0001)"
                    className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white uppercase"
                  />
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 font-mono text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.isFoodFda}
                      onChange={(e) => setForm({ ...form, isFoodFda: e.target.checked })}
                      className="rounded border-white/20"
                    />
                    Perishable / FDA Food Commodity (2-Hr Window)
                  </label>
                  <input
                    type="text"
                    value={form.fdaPriorNoticeNumber}
                    onChange={(e) => setForm({ ...form, fdaPriorNoticeNumber: e.target.value.toUpperCase() })}
                    placeholder="FDA 2-Hr Prior Notice Confirmation #"
                    className="w-full rounded bg-bro-steel border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white uppercase"
                  />
                </div>
              </div>
            </div>

            {/* Shipment Commodity, HS Code, Weight kg, CUSMA */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="sm:col-span-2">
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Commodity Description</label>
                <input
                  type="text"
                  required
                  value={form.commodity}
                  onChange={(e) => setForm({ ...form, commodity: e.target.value })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">HS / HTS Code (6–10 digits)</label>
                <input
                  type="text"
                  required
                  value={form.hsCode}
                  onChange={(e) => setForm({ ...form, hsCode: e.target.value.replace(/\D/g, '') })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Weight (kg, max 36,287)</label>
                <input
                  type="number"
                  required
                  min={1}
                  step="0.1"
                  value={form.weightKg}
                  onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-3 py-1.5 font-mono text-xs text-white tabular-nums"
                />
              </div>

              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Origin Country</label>
                <select
                  value={form.countryOfOrigin}
                  onChange={(e) => setForm({ ...form, countryOfOrigin: e.target.value as 'CA' | 'US' | 'MX' | 'OTHER' })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white"
                >
                  <option value="CA">CA — Canada</option>
                  <option value="US">US — United States</option>
                  <option value="MX">MX — Mexico</option>
                  <option value="OTHER">OTHER (Non-CUSMA)</option>
                </select>
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Invoice Value ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={form.invoiceValueDollars}
                  onChange={(e) => setForm({ ...form, invoiceValueDollars: e.target.value })}
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Currency / Qty</label>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value as 'CAD' | 'USD' })}
                    className="rounded bg-bro-obsidian border border-white/15 px-2 py-1.5 font-mono text-xs text-white"
                  >
                    <option value="CAD">CAD</option>
                    <option value="USD">USD</option>
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                    className="rounded bg-bro-obsidian border border-white/15 px-2 py-1.5 font-mono text-xs text-white tabular-nums"
                  />
                </div>
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase text-slate-400 mb-1">Overweight Permit #</label>
                <input
                  type="text"
                  value={form.overweightPermitNumber}
                  onChange={(e) => setForm({ ...form, overweightPermitNumber: e.target.value })}
                  placeholder="Optional if >36,287kg"
                  className="w-full rounded bg-bro-obsidian border border-white/15 px-2.5 py-1.5 font-mono text-xs text-white"
                />
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-3 pt-2 border-t border-white/10">
              <label className="inline-flex items-center gap-2 font-mono text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.cusmaCertOnFile}
                  onChange={(e) => setForm({ ...form, cusmaCertOnFile: e.target.checked })}
                  className="rounded border-white/20"
                />
                CUSMA / USMCA Certificate of Origin On File
              </label>

              <button
                type="submit"
                disabled={submitBusy}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded bg-bro-cyan text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyan-300 cursor-pointer disabled:opacity-50"
              >
                <ShieldCheck className="w-4 h-4" />
                {submitBusy ? 'Validating & Archiving...' : 'Validate & Generate Code-128 Cover Sheet'}
              </button>
            </div>
          </form>
        </section>

        {/* Right Panel: Deterministic Validation Report */}
        <section aria-label="Customs Compliance Validation Report" className="xl:col-span-5 glass-panel rounded-lg border border-white/10 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Deterministic Pre-Flight Validation Report
            </h2>
            {latestFiling && (
              <span
                className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold uppercase ${
                  latestFiling.report.compliant
                    ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
                    : 'bg-rose-950/70 border-bro-crimson/50 text-rose-200'
                }`}
              >
                {latestFiling.report.compliant ? 'COMPLIANT' : 'BLOCKED'}
              </span>
            )}
          </div>

          {!latestFiling ? (
            <div className="py-12 text-center font-mono text-xs text-slate-400 space-y-2">
              <FileCheck2 className="w-7 h-7 text-bro-gold mx-auto" />
              <p>Submit the ACE PAPS / ACI PARS builder to run all 9 deterministic customs gates.</p>
              <p className="text-[11px] text-slate-500">
                Verifies Carrier Prefix, ISO 3779 VIN, FAST credentials, Pre-Arrival Lead Time, FDA 2-Hr Notice, CARM Release 2 IOR RPP bond, CUSMA surtax warnings &amp; GVW limits.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                className={`p-3.5 rounded-lg border flex items-center justify-between gap-3 ${
                  latestFiling.report.compliant
                    ? 'bg-emerald-950/40 border-emerald-500/40'
                    : 'bg-rose-950/40 border-bro-crimson/40'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {latestFiling.report.compliant ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <ShieldX className="w-5 h-5 text-bro-crimson shrink-0" />
                  )}
                  <div className="font-mono text-xs">
                    <div className="font-bold text-white">{latestFiling.report.manifestId}</div>
                    <div className="text-[10px] text-slate-300">
                      {latestFiling.report.portName} · Lead Time: {latestFiling.report.leadTimeMinutes}m (req {latestFiling.report.requiredLeadTimeMinutes}m)
                    </div>
                  </div>
                </div>
              </div>

              <a
                href={latestFiling.coverSheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-bro-gold text-bro-obsidian font-mono text-xs font-bold uppercase tracking-wider hover:bg-amber-400 transition-colors"
              >
                <Download className="w-4 h-4" />
                Download Code-128 Cover Sheet PDF
              </a>

              {/* Individual Checks */}
              <div className="space-y-2">
                {latestFiling.report.checks.map((chk) => (
                  <div
                    key={chk.code}
                    className="p-2.5 rounded bg-bro-obsidian/70 border border-white/10 flex items-start justify-between gap-2 font-mono text-[11px]"
                  >
                    <div>
                      <div className="text-white font-semibold">{chk.label}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5">{chk.detail}</div>
                    </div>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold shrink-0 ${
                        chk.status === 'pass'
                          ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-500/40'
                          : chk.status === 'warn'
                            ? 'bg-bro-gold/15 text-bro-gold border border-bro-gold/40'
                            : 'bg-bro-crimson/15 text-bro-crimson border border-bro-crimson/40'
                      }`}
                    >
                      {chk.status}
                    </span>
                  </div>
                ))}
              </div>

              {latestFiling.report.warnings.length > 0 && (
                <div className="p-3 rounded bg-bro-gold/10 border border-bro-gold/35 space-y-1">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase text-bro-gold">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Tariff / Regulatory Warnings
                  </div>
                  {latestFiling.report.warnings.map((w, idx) => (
                    <p key={idx} className="font-mono text-[11px] text-amber-100">{w}</p>
                  ))}
                </div>
              )}

              {latestFiling.report.errors.length > 0 && (
                <div className="p-3 rounded bg-rose-950/50 border border-bro-crimson/40 space-y-1">
                  <div className="font-mono text-[10px] font-bold uppercase text-bro-crimson">
                    Blocking Compliance Failures
                  </div>
                  {latestFiling.report.errors.map((err, idx) => (
                    <p key={idx} className="font-mono text-[11px] text-rose-100">{err}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Persisted Customs Manifests Registry */}
      <section aria-label="Filed and Draft Customs Manifests" className="glass-panel rounded-lg border border-white/10 overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-bro-cyan" />
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-white">
              Filed &amp; RNS-Tracked Manifests ({manifests.length})
            </h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-bro-obsidian/50 font-mono text-[10px] uppercase text-slate-400">
                <th className="px-4 py-2.5">Control #</th>
                <th className="px-4 py-2.5">Type / Port</th>
                <th className="px-4 py-2.5">ETA (UTC)</th>
                <th className="px-4 py-2.5">CARM / FDA</th>
                <th className="px-4 py-2.5">RNS Status</th>
                <th className="px-4 py-2.5 text-right">Cover Sheet PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs font-mono">
              {manifests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No customs manifests filed yet.
                  </td>
                </tr>
              ) : (
                manifests.map((m) => (
                  <tr key={m.id} className="hover:bg-white/5">
                    <td className="px-4 py-3">
                      <div className="font-bold text-white">{m.controlNumber}</div>
                      <div className="text-[10px] text-slate-400">Trip: {m.tripNumber} {m.loadId ? `· ${m.loadId}` : ''}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-bro-gold font-bold">{m.manifestType}</span>
                      <div className="text-[10px] text-slate-400">Port {m.portCode}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300 tabular-nums whitespace-nowrap">
                      {m.etaUtc.slice(0, 16).replace('T', ' ')}Z
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 text-[10px]">
                        <span
                          className={`px-1.5 py-0.5 rounded border ${
                            m.carmIorVerified
                              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                              : 'bg-slate-800 border-slate-700 text-slate-400'
                          }`}
                        >
                          CARM {m.carmIorVerified ? 'OK' : 'UNVER'}
                        </span>
                        {m.fdaPriorNoticeNum && (
                          <span className="px-1.5 py-0.5 rounded bg-bro-cyan/15 border border-bro-cyan/40 text-bro-cyan">
                            FDA: {m.fdaPriorNoticeNum}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] uppercase font-bold ${
                          m.status === 'released'
                            ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
                            : m.status === 'held'
                              ? 'bg-rose-950/70 border-bro-crimson/50 text-rose-200'
                              : m.status === 'filed'
                                ? 'bg-bro-cyan/15 border-bro-cyan/40 text-bro-cyan'
                                : 'bg-bro-gold/15 border-bro-gold/40 text-bro-gold'
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <a
                        href={`/api/ops/customs/manifests/${encodeURIComponent(m.id)}/cover-sheet.pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-bro-steel hover:bg-slate-800 border border-white/15 text-[10px] text-bro-cyan font-bold"
                      >
                        <Download className="w-3 h-3" />
                        Code-128 PDF
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
