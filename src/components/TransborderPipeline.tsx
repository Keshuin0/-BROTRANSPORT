import { useState, useMemo } from 'react';
import { ShieldCheck, ShieldAlert, ScanLine } from 'lucide-react';
import type { CustomsValidationReport } from '@bro/contracts';
import { renderCode128Svg } from '../lib/barcode';

const futureEtaIso = (hoursAhead: number) =>
  new Date(Date.now() + hoursAhead * 3600_000).toISOString();

const MANIFEST_PRESETS: Record<string, { label: string; build: () => Record<string, unknown> }> = {
  ace_valid: {
    label: 'Valid U.S.-Bound ACE PAPS (PEI → Boston, FDA OK)',
    build: () => ({
      manifestType: 'ACE_PAPS',
      scacOrCarrierCode: 'BROP',
      controlNumber: 'BROP8843921',
      tripNumber: 'BROP20261120A',
      portCode: '0115',
      etaUtc: futureEtaIso(4),
      conveyance: { vin: '1HGCM82633A004352', plate: 'PE9948', jurisdiction: 'PE' },
      crew: [{ fastCardNumber: '980012345', firstName: 'Liam', lastName: 'Gallant', dateOfBirth: '1984-05-10' }],
      carmIorAccountVerified: false,
      fdaPriorNoticeNumber: 'FDA-PN-88439210',
      shipments: [
        {
          commodity: 'Fresh PEI Potatoes',
          hsCode: '070190',
          countryOfOrigin: 'CA',
          cusmaCertOnFile: true,
          invoiceValueCents: 4200000,
          currency: 'USD',
          weightKg: 21500,
          quantity: 24,
          packageType: 'Pallet',
          isFoodFda: true,
          shipperName: 'Cavendish Valley Produce Co.',
          shipperAddress: '100 Harvest Rd, Summerside, PE',
          consigneeName: 'New England Fresh Market Hub',
          consigneeAddress: '45 Terminal Way, Boston, MA',
        },
      ],
    }),
  },
  aci_valid: {
    label: 'Valid Canada-Bound ACI PARS (CARM Release 2 Verified)',
    build: () => ({
      manifestType: 'ACI_PARS',
      scacOrCarrierCode: 'BROP',
      controlNumber: 'BROP9948201',
      tripNumber: 'BROP20261120B',
      portCode: '0712',
      etaUtc: futureEtaIso(3),
      conveyance: { vin: '1HGCM82633A004352', plate: 'NB5022', jurisdiction: 'NB' },
      crew: [{ fastCardNumber: '980077421', firstName: 'Nadia', lastName: 'Tremblay', dateOfBirth: '1987-09-22' }],
      carmIorAccountVerified: true,
      carmImporterBnRm: '604918220RM0001',
      shipments: [
        {
          commodity: 'Galvanized Structural Steel I-Beams',
          hsCode: '721632',
          countryOfOrigin: 'US',
          cusmaCertOnFile: true,
          invoiceValueCents: 6150000,
          currency: 'CAD',
          weightKg: 29400,
          quantity: 12,
          packageType: 'Bundle',
          isFoodFda: false,
          shipperName: 'Northeast Steel Supply',
          shipperAddress: '12 Foundry Rd, Albany, NY',
          consigneeName: 'Fundy Structural Steel Ltd.',
          consigneeAddress: '88 Industrial Pkwy, Moncton, NB',
        },
      ],
    }),
  },
  violations: {
    label: 'Failure Demo: Bad ISO VIN + Missing CARM RPP + Overweight',
    build: () => ({
      manifestType: 'ACI_PARS',
      scacOrCarrierCode: 'BROP',
      controlNumber: 'BADP0001234',
      tripNumber: 'BROP20261120X',
      portCode: '3801',
      etaUtc: futureEtaIso(0.5),
      conveyance: { vin: '1HGCM82693A004352', plate: 'ON4412', jurisdiction: 'ON' },
      crew: [{ fastCardNumber: '12345', firstName: 'Test', lastName: 'Driver', dateOfBirth: '1990-01-01' }],
      carmIorAccountVerified: false,
      shipments: [
        {
          commodity: 'Unclassified Industrial Machinery',
          hsCode: '842952',
          countryOfOrigin: 'OTHER',
          cusmaCertOnFile: false,
          invoiceValueCents: 9200000,
          currency: 'CAD',
          weightKg: 39800,
          quantity: 4,
          packageType: 'Crate',
          isFoodFda: false,
          shipperName: 'Midwest Machinery',
          shipperAddress: '900 Freight Ave, Detroit, MI',
          consigneeName: 'Ontario Plant Works',
          consigneeAddress: '400 Huron Rd, Windsor, ON',
        },
      ],
    }),
  },
};

export default function TransborderPipeline() {
  const [presetKey, setPresetKey] = useState<string>('ace_valid');
  const [manifestStr, setManifestStr] = useState(() => JSON.stringify(MANIFEST_PRESETS.ace_valid.build(), null, 2));
  const [report, setReport] = useState<CustomsValidationReport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const selectPreset = (key: string) => {
    setPresetKey(key);
    setManifestStr(JSON.stringify(MANIFEST_PRESETS[key].build(), null, 2));
    setReport(null);
    setParseError(null);
  };

  const runValidation = async () => {
    setScanning(true);
    setParseError(null);
    setReport(null);
    try {
      const obj = JSON.parse(manifestStr);
      const res = await fetch('/api/customs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj),
      });
      const data = (await res.json()) as CustomsValidationReport & { error?: string; issues?: string[] };
      if (!res.ok) {
        setParseError(data.issues ? data.issues.join(' | ') : data.error || 'Schema parse rejection.');
      } else {
        setReport(data);
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON payload.');
    } finally {
      setScanning(false);
    }
  };

  const barcodeSvg = useMemo(() => {
    if (!report?.compliant) return null;
    try {
      const obj = JSON.parse(manifestStr) as { controlNumber?: string };
      if (!obj.controlNumber) return null;
      return renderCode128Svg(obj.controlNumber, { height: 52, moduleWidth: 2, includeText: true });
    } catch {
      return null;
    }
  }, [report, manifestStr]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {Object.entries(MANIFEST_PRESETS).map(([key, item]) => (
          <button
            key={key}
            type="button"
            onClick={() => selectPreset(key)}
            aria-pressed={presetKey === key}
            className={`min-h-[44px] px-4 py-2 rounded-full border text-xs font-medium transition-colors cursor-pointer ${
              presetKey === key
                ? 'border-white bg-white text-black font-semibold'
                : 'border-white/15 bg-[#060912] text-slate-200 hover:text-white hover:border-white/30'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 rounded-3xl surface-ceramic p-5 sm:p-6 flex flex-col justify-between space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] pb-3 font-mono text-xs">
            <span className="text-white font-bold">ACE_PAPS / ACI_PARS JSON MANIFEST</span>
            <span className="text-bro-cyan">ISO 3779 · CARM R2 · FDA</span>
          </div>

          <textarea
            aria-label="Customs eManifest JSON payload"
            value={manifestStr}
            onChange={(e) => setManifestStr(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[340px] bg-[#060912] text-cyan-200 border border-white/15 rounded-2xl p-4 font-mono text-xs outline-none focus:border-bro-cyan resize-y"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-slate-300">
              Deterministic validation against real CBP/CBSA compliance rules.
            </span>
            <button
              type="button"
              onClick={runValidation}
              disabled={scanning}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white hover:bg-bro-cyan text-black text-xs font-semibold tracking-tight transition-colors cursor-pointer disabled:opacity-50"
            >
              <ScanLine className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{scanning ? 'Validating…' : 'Run Pre-Flight Check'}</span>
            </button>
          </div>
        </div>

        <div className="lg:col-span-5 rounded-3xl surface-ceramic p-5 sm:p-6 flex flex-col justify-between space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] pb-3 font-mono text-xs">
            <span className="text-white font-bold">PRE-FLIGHT AUDIT TERMINAL</span>
            {report ? (
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-bold text-[11px] ${
                  report.compliant
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                    : 'bg-rose-950 text-rose-200 border border-rose-500/50'
                }`}
              >
                {report.compliant ? <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                {report.compliant ? 'BORDER COMPLIANT' : 'REJECTED — HOLD DISPATCH'}
              </span>
            ) : (
              <span className="text-[11px] text-slate-300">AWAITING SCAN</span>
            )}
          </div>

          <div className="flex-1 space-y-2.5 font-mono text-xs overflow-y-auto max-h-[340px]">
            {parseError && (
              <div role="alert" className="p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/40 text-rose-200">
                [SCHEMA ERROR] {parseError}
              </div>
            )}

            {report && (
              <>
                <div className="p-3.5 rounded-2xl bg-[#060912] border border-white/[0.08] text-slate-200 space-y-1">
                  <div>Manifest ID: <strong className="text-white">{report.manifestId}</strong></div>
                  <div>Port: <strong className="text-bro-cyan">{report.portName}</strong></div>
                  <div>Lead Time: <strong className="tabular-nums">{report.leadTimeMinutes}m</strong> (min {report.requiredLeadTimeMinutes}m)</div>
                </div>

                {report.checks.map((chk) => (
                  <div
                    key={chk.code}
                    className={`p-3 rounded-xl border-l-2 bg-[#060912] ${
                      chk.status === 'pass'
                        ? 'border-emerald-400 text-slate-200'
                        : chk.status === 'warn'
                          ? 'border-bro-gold text-amber-200'
                          : 'border-rose-500 text-rose-200'
                    }`}
                  >
                    <div className="flex justify-between gap-2 font-bold">
                      <span>{chk.label}</span>
                      <span className="uppercase text-[11px] shrink-0">{chk.status}</span>
                    </div>
                    <div className="text-[11px] text-slate-300 mt-0.5">{chk.detail}</div>
                  </div>
                ))}

                {report.warnings.map((w, i) => (
                  <div key={i} className="p-3 rounded-xl bg-amber-950/30 border border-bro-gold/40 text-amber-200 text-[11px]">
                    [WARNING] {w}
                  </div>
                ))}
              </>
            )}

            {!report && !parseError && (
              <div className="py-10 text-center text-slate-300">
                Select a preset or edit the JSON manifest, then click Run Pre-Flight Check.
              </div>
            )}
          </div>

          {barcodeSvg && (
            <div className="p-3.5 rounded-2xl bg-white text-black space-y-1.5 overflow-hidden">
              <div className="font-mono text-[10px] font-bold uppercase text-slate-800 text-center">
                Scannable ISO/IEC 15417 Code-128B PAPS/PARS Barcode
              </div>
              <div className="w-full flex justify-center" dangerouslySetInnerHTML={{ __html: barcodeSvg }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
