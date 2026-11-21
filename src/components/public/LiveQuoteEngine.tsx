import { useState, useEffect, useMemo, type SyntheticEvent } from 'react';
import { Calculator, CheckCircle2, Leaf, MapPin, ShieldCheck, Truck, Snowflake, Layers, ArrowRight } from 'lucide-react';
import type { EquipmentType, Currency, RateCalculationResult } from '@bro/contracts';
import { solveOfflinePow } from '../../lib/powWorker';
import { sha256Hex } from '../../lib/ebolCrypto';

interface HubOption {
  label: string;
  city: string;
  provState: string;
  country: 'CA' | 'US' | 'MX';
  lat: number;
  lon: number;
}

const HUB_PRESETS: HubOption[] = [
  { label: 'Charlottetown, PE (PEI HQ)', city: 'Charlottetown', provState: 'PE', country: 'CA', lat: 46.2507, lon: -63.1375 },
  { label: 'Halifax, NS (Port Terminal)', city: 'Halifax', provState: 'NS', country: 'CA', lat: 44.6488, lon: -63.5752 },
  { label: 'Moncton, NB (Atlantic Hub)', city: 'Moncton', provState: 'NB', country: 'CA', lat: 46.0878, lon: -64.7782 },
  { label: 'Montreal, QC (Corridor)', city: 'Montreal', provState: 'QC', country: 'CA', lat: 45.5017, lon: -73.5673 },
  { label: 'Toronto, ON (GTA Terminal)', city: 'Toronto', provState: 'ON', country: 'CA', lat: 43.6532, lon: -79.3832 },
  { label: 'Calgary, AB (Prairie Hub)', city: 'Calgary', provState: 'AB', country: 'CA', lat: 51.0447, lon: -114.0719 },
  { label: 'Vancouver, BC (Pacific Gate)', city: 'Vancouver', provState: 'BC', country: 'CA', lat: 49.2827, lon: -123.1207 },
  { label: 'Boston, MA (New England Hub)', city: 'Boston', provState: 'MA', country: 'US', lat: 42.3601, lon: -71.0589 },
  { label: 'New York / Newark, NJ', city: 'Newark', provState: 'NJ', country: 'US', lat: 40.7128, lon: -74.006 },
  { label: 'Detroit, MI (Cross-Border)', city: 'Detroit', provState: 'MI', country: 'US', lat: 42.3314, lon: -83.0458 },
  { label: 'Chicago, IL (Midwest Hub)', city: 'Chicago', provState: 'IL', country: 'US', lat: 41.8781, lon: -87.6298 },
  { label: 'Atlanta, GA (Southeast)', city: 'Atlanta', provState: 'GA', country: 'US', lat: 33.749, lon: -84.388 },
  { label: 'Dallas, TX (South Central)', city: 'Dallas', provState: 'TX', country: 'US', lat: 32.7767, lon: -96.797 },
  { label: 'Los Angeles, CA (West Coast)', city: 'Los Angeles', provState: 'CA', country: 'US', lat: 34.0522, lon: -118.2437 },
  { label: 'Seattle, WA (Pacific NW)', city: 'Seattle', provState: 'WA', country: 'US', lat: 47.6062, lon: -122.3321 },
];

function findHubIndex(raw: string | null): number {
  if (!raw) return -1;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return -1;
  const cityPart = normalized.split(',')[0].trim();

  const exactIdx = HUB_PRESETS.findIndex(
    (h) =>
      h.city.toLowerCase() === normalized ||
      h.city.toLowerCase() === cityPart ||
      h.provState.toLowerCase() === normalized ||
      h.label.toLowerCase() === normalized,
  );
  if (exactIdx >= 0) return exactIdx;

  return HUB_PRESETS.findIndex(
    (h) =>
      (cityPart.length >= 2 && h.city.toLowerCase().includes(cityPart)) ||
      h.label.toLowerCase().includes(normalized) ||
      (cityPart.length >= 2 && h.label.toLowerCase().includes(cityPart)),
  );
}

interface EstimateApiResponse {
  estimate: RateCalculationResult;
  routingSource: string;
  recommendedPort?: { cbpCode: string; crossingName: string; waitMinutes: number | null } | null;
}

export default function LiveQuoteEngine() {
  const [equipmentType, setEquipmentType] = useState<EquipmentType>('reefer');
  const [originIdx, setOriginIdx] = useState(0); // Charlottetown, PE
  const [destIdx, setDestIdx] = useState(7); // Boston, MA
  const [weightLbs, setWeightLbs] = useState(36000);
  const [tempSetpointC, setTempSetpointC] = useState(-18);
  const [requiresTarp, setRequiresTarp] = useState(false);
  const [requiresStrapping, setRequiresStrapping] = useState(false);
  const [requiresTeamDriver, setRequiresTeamDriver] = useState(false);
  const [isHazmat, setIsHazmat] = useState(false);
  const [isFoodFda, setIsFoodFda] = useState(true);
  const [currency, setCurrency] = useState<Currency>('CAD');
  const [commodity, setCommodity] = useState('Chilled Atlantic Produce / Commercial Goods');

  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  const [estimateResp, setEstimateResp] = useState<EstimateApiResponse | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ quoteRef: string; totalCents: number; currency: string; co2Kg: number } | null>(null);

  // Hydrate URL query parameters from Homepage Fast Quote, Fleet Blueprint Deck, 3D Globe, or Cmd+K!
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const eq = sp.get('equipment')?.toLowerCase().replace(/[\s-]/g, '_');
    if (eq === 'dry_van' || eq === 'reefer' || eq === 'flatbed') setEquipmentType(eq);
    const wt = Number(sp.get('weight'));
    if (Number.isFinite(wt) && wt >= 100 && wt <= 45000) setWeightLbs(Math.round(wt));

    const origIdx = findHubIndex(sp.get('origin'));
    if (origIdx >= 0) setOriginIdx(origIdx);

    const dstIdx = findHubIndex(sp.get('dest') ?? sp.get('destination'));
    if (dstIdx >= 0) setDestIdx(dstIdx);
  }, []);

  const origin = HUB_PRESETS[originIdx];
  const dest = HUB_PRESETS[destIdx];

  const estimatePayload = useMemo(
    () => ({
      equipmentType,
      originCity: origin.city,
      originProvinceState: origin.provState,
      originCountry: origin.country,
      originLat: origin.lat,
      originLon: origin.lon,
      destCity: dest.city,
      destProvinceState: dest.provState,
      destCountry: dest.country,
      destLat: dest.lat,
      destLon: dest.lon,
      weightLbs,
      tempSetpointC: equipmentType === 'reefer' ? tempSetpointC : undefined,
      requiresTarp: equipmentType === 'flatbed' ? requiresTarp : false,
      requiresStrapping: equipmentType === 'flatbed' ? requiresStrapping : false,
      requiresTeamDriver,
      isHazmat,
      isFoodFda,
      currency,
    }),
    [
      equipmentType,
      origin,
      dest,
      weightLbs,
      tempSetpointC,
      requiresTarp,
      requiresStrapping,
      requiresTeamDriver,
      isHazmat,
      isFoodFda,
      currency,
    ],
  );

  // Debounced live highway & rate estimation
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setEstimating(true);
      try {
        const res = await fetch('/api/quotes/estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(estimatePayload),
          signal: controller.signal,
        });
        if (res.ok) {
          setEstimateResp((await res.json()) as EstimateApiResponse);
        }
      } catch {
        // aborted or offline
      } finally {
        setEstimating(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [estimatePayload]);

  const fmtMoney = (cents: number, cur: string) =>
    `${(cents / 100).toLocaleString('en-CA', { style: 'currency', currency: cur })}`;

  const handleConfirmQuote = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const corePayload = `${contactEmail.trim()}:${origin.country}:${dest.country}:${equipmentType}`;
      const payloadHash = await sha256Hex(corePayload);
      const offlinePowToken = await solveOfflinePow(payloadHash);

      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...estimatePayload,
          commodity,
          contactName,
          contactEmail,
          contactPhone,
          offlinePowToken,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        quoteRef?: string;
        estimate?: RateCalculationResult;
      };
      if (!res.ok || !data.quoteRef || !data.estimate) {
        throw new Error(data.error || 'Unable to lock rate quote.');
      }
      setConfirmed({
        quoteRef: data.quoteRef,
        totalCents: data.estimate.totalCents,
        currency: data.estimate.currency,
        co2Kg: data.estimate.co2Kg,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quote transmission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      {/* Left 7 cols: Configuration & Booking Form */}
      <form onSubmit={handleConfirmQuote} className="lg:col-span-7 space-y-6 rounded-3xl surface-ceramic p-5 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-4">
          <div className="min-w-0">
            <span className="font-mono text-[11px] uppercase tracking-wider text-bro-cyan">
              Geo-Routed Spot &amp; Contract Pricing
            </span>
            <h2 className="text-xl font-display font-bold text-white mt-0.5">
              Configure Commercial Shipment
            </h2>
          </div>
          <div
            role="group"
            aria-label="Billing currency"
            className="inline-flex rounded-xl border border-white/15 p-1 bg-[#060912] font-mono text-xs shrink-0"
          >
            {(['CAD', 'USD'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                aria-pressed={currency === c}
                className={`min-h-[44px] px-3.5 py-2 rounded-lg cursor-pointer transition-colors ${
                  currency === c
                    ? 'bg-bro-gold text-black font-bold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Equipment Selector */}
        <div className="space-y-2">
          <span className="block font-mono text-xs uppercase text-slate-300">Equipment Division</span>
          <div role="group" aria-label="Equipment division" className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {[
              { id: 'dry_van', label: '53ft Dry Van', sub: 'Enclosed Box', Icon: Truck },
              { id: 'reefer', label: '53ft Reefer', sub: 'Cold-Chain', Icon: Snowflake },
              { id: 'flatbed', label: '53ft Flatbed', sub: 'Open Deck', Icon: Layers },
            ].map(({ id, label, sub, Icon }) => {
              const active = equipmentType === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setEquipmentType(id as EquipmentType)}
                  aria-pressed={active}
                  className={`min-h-[48px] p-3.5 rounded-2xl border text-left transition-colors cursor-pointer flex sm:block items-center justify-between gap-3 sm:space-y-1 ${
                    active
                      ? 'border-bro-cyan bg-bro-cyan/10 text-white'
                      : 'border-white/10 bg-[#060912] text-slate-300 hover:text-white hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center gap-2.5 sm:block sm:space-y-1">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-bro-cyan' : 'text-slate-300'}`} aria-hidden="true" />
                    <div className="font-mono text-xs font-bold text-white">{label}</div>
                  </div>
                  <div className="text-[11px] text-slate-300">{sub}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Origin & Destination Hubs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="q-origin" className="block font-mono text-[11px] uppercase text-slate-300">
              Origin Corridor Hub
            </label>
            <select
              id="q-origin"
              value={originIdx}
              onChange={(e) => setOriginIdx(Number(e.target.value))}
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-bro-cyan"
            >
              {HUB_PRESETS.map((h, i) => (
                <option key={h.label} value={i}>{h.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="q-dest" className="block font-mono text-[11px] uppercase text-slate-300">
              Destination Corridor Hub
            </label>
            <select
              id="q-dest"
              value={destIdx}
              onChange={(e) => setDestIdx(Number(e.target.value))}
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-bro-cyan"
            >
              {HUB_PRESETS.map((h, i) => (
                <option key={h.label} value={i}>{h.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Weight Slider + Conditional Reefer/Flatbed Controls */}
        <div className="space-y-4 pt-2 border-t border-white/[0.08]">
          <div className="space-y-1.5">
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="q-weight" className="text-slate-300 uppercase">
                Gross Cargo Weight
              </label>
              <span className="text-bro-gold font-bold tabular-nums">{weightLbs.toLocaleString()} LBS</span>
            </div>
            <input
              id="q-weight"
              type="range"
              min={1000}
              max={45000}
              step={500}
              value={weightLbs}
              onChange={(e) => setWeightLbs(Number(e.target.value))}
              className="w-full min-h-[44px] accent-bro-gold cursor-pointer"
            />
          </div>

          {equipmentType === 'reefer' && (
            <div className="space-y-1.5 p-4 rounded-2xl bg-[#060912] border border-bro-cyan/25">
              <div className="flex justify-between font-mono text-xs">
                <label htmlFor="q-temp" className="text-bro-cyan uppercase">
                  Thermo King Setpoint
                </label>
                <span className="text-white font-bold tabular-nums">{tempSetpointC.toFixed(1)}°C</span>
              </div>
              <input
                id="q-temp"
                type="range"
                min={-28}
                max={20}
                step={0.5}
                value={tempSetpointC}
                onChange={(e) => setTempSetpointC(Number(e.target.value))}
                className="w-full min-h-[44px] accent-bro-cyan cursor-pointer"
              />
            </div>
          )}

          {equipmentType === 'flatbed' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono text-xs">
              <label className="min-h-[44px] flex items-center gap-2.5 p-3 rounded-xl border border-white/10 bg-[#060912] text-slate-200 cursor-pointer">
                <input type="checkbox" checked={requiresTarp} onChange={(e) => setRequiresTarp(e.target.checked)} className="w-4 h-4 accent-bro-gold" />
                <span>8ft Heavy-Duty Weather Tarping</span>
              </label>
              <label className="min-h-[44px] flex items-center gap-2.5 p-3 rounded-xl border border-white/10 bg-[#060912] text-slate-200 cursor-pointer">
                <input type="checkbox" checked={requiresStrapping} onChange={(e) => setRequiresStrapping(e.target.checked)} className="w-4 h-4 accent-bro-gold" />
                <span>Chains, Binders &amp; Straps</span>
              </label>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono text-xs">
            <label className="min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-white/10 bg-[#060912] text-slate-200 cursor-pointer">
              <input type="checkbox" checked={requiresTeamDriver} onChange={(e) => setRequiresTeamDriver(e.target.checked)} className="w-4 h-4 accent-bro-cyan" />
              <span>Team Expedite</span>
            </label>
            <label className="min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-white/10 bg-[#060912] text-slate-200 cursor-pointer">
              <input type="checkbox" checked={isFoodFda} onChange={(e) => setIsFoodFda(e.target.checked)} className="w-4 h-4 accent-bro-cyan" />
              <span>FDA / CFIA Food</span>
            </label>
            <label className="min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-white/10 bg-[#060912] text-slate-200 cursor-pointer">
              <input type="checkbox" checked={isHazmat} onChange={(e) => setIsHazmat(e.target.checked)} className="w-4 h-4 accent-bro-gold" />
              <span>TDG / DOT Hazmat</span>
            </label>
          </div>
        </div>

        {/* Contact & Commodity */}
        <div className="space-y-3.5 pt-4 border-t border-white/[0.08]">
          <div className="space-y-1.5">
            <label htmlFor="q-commodity" className="block font-mono text-[11px] uppercase text-slate-300">
              Commodity Description
            </label>
            <input
              id="q-commodity"
              type="text"
              required
              value={commodity}
              onChange={(e) => setCommodity(e.target.value)}
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-bro-cyan"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="q-contact-name" className="block font-mono text-[11px] uppercase text-slate-300">
                Contact Name
              </label>
              <input
                id="q-contact-name"
                type="text"
                required
                placeholder="Owen MacLeod"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="q-contact-email" className="block font-mono text-[11px] uppercase text-slate-300">
                Corporate Email
              </label>
              <input
                id="q-contact-email"
                type="email"
                required
                placeholder="dispatch@company.com"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="q-contact-phone" className="block font-mono text-[11px] uppercase text-slate-300">
                Phone (10-digit)
              </label>
              <input
                id="q-contact-phone"
                type="tel"
                required
                minLength={10}
                placeholder="902-555-0192"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </div>
        </div>

        {error && (
          <div role="alert" className="p-3.5 rounded-2xl bg-rose-950/60 border border-rose-500/40 text-rose-200 text-xs font-mono">
            {error}
          </div>
        )}

        {confirmed ? (
          <div className="p-5 rounded-2xl bg-emerald-950/40 border border-emerald-500/40 space-y-3">
            <div className="flex items-center gap-2 text-emerald-300 font-mono text-xs font-bold uppercase">
              <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span>Rate Quote Locked &amp; Persisted — Ref: {confirmed.quoteRef}</span>
            </div>
            <div className="text-sm text-white">
              Guaranteed Spot Estimate:{' '}
              <strong className="font-mono text-bro-gold tabular-nums">
                {fmtMoney(confirmed.totalCents, confirmed.currency)} {confirmed.currency}
              </strong>{' '}
              · SmartWay Footprint: <span className="font-mono text-emerald-300 tabular-nums">{confirmed.co2Kg} kg CO₂e</span>
            </div>
            <div className="flex flex-wrap gap-3 pt-1">
              <a
                href="/portal/shipper"
                className="min-h-[44px] inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-white hover:bg-bro-cyan text-black text-xs font-semibold transition-colors"
              >
                <span>Book in Shipper Portal</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
              <button
                type="button"
                onClick={() => setConfirmed(null)}
                className="min-h-[44px] px-4 py-2.5 rounded-full border border-white/15 hover:border-white/30 text-xs font-medium text-slate-200 cursor-pointer transition-colors"
              >
                New Calculation
              </button>
            </div>
          </div>
        ) : (
          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[48px] flex items-center justify-center gap-2 py-3.5 rounded-full bg-bro-gold hover:bg-amber-400 text-black text-sm font-semibold tracking-tight transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Calculator className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{submitting ? 'Locking Guaranteed Spot Rate...' : 'Lock Rate & Dispatch Confirmation'}</span>
          </button>
        )}
      </form>

      {/* Right 5 cols: Real-Time Itemized Rate Breakdown */}
      <aside className="lg:col-span-5 rounded-3xl surface-ceramic border-bro-gold/30 p-6 space-y-5 lg:sticky lg:top-24">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] pb-3.5">
          <span className="font-mono text-xs font-bold uppercase text-bro-gold">Live Rate Breakdown</span>
          <span className="font-mono text-[11px] text-slate-300">
            {estimating ? 'Recalculating…' : estimateResp?.routingSource || 'OSRM / GEO'}
          </span>
        </div>

        {estimateResp ? (
          <div className={`space-y-4 transition-opacity duration-200 ${estimating ? 'opacity-60' : 'opacity-100'}`}>
            <div className="p-4 rounded-2xl bg-[#060912] border border-white/[0.08]">
              <div className="font-mono text-[11px] uppercase text-slate-300">All-In Estimated Total</div>
              <div className="text-3xl font-display font-bold text-white tabular-nums mt-1">
                {fmtMoney(estimateResp.estimate.totalCents, estimateResp.estimate.currency)}
                <span className="text-xs font-mono text-bro-gold ml-2">{estimateResp.estimate.currency}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-slate-300 tabular-nums">
                <span>
                  {estimateResp.estimate.distanceKm.toLocaleString()} km ({estimateResp.estimate.distanceMiles.toLocaleString()} mi)
                </span>
                <span className="text-bro-cyan tabular-nums">ETA ~{estimateResp.estimate.estimatedTransitHours} hrs</span>
              </div>
            </div>

            <div className="space-y-2.5 font-mono text-xs text-slate-200">
              <div className="flex justify-between">
                <span className="text-slate-300">Base Linehaul</span>
                <span className="tabular-nums">{fmtMoney(estimateResp.estimate.linehaulCents, estimateResp.estimate.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Diesel Fuel Surcharge (FSC)</span>
                <span className="tabular-nums">{fmtMoney(estimateResp.estimate.fuelSurchargeCents, estimateResp.estimate.currency)}</span>
              </div>
              {estimateResp.estimate.customsBrokerageCents > 0 && (
                <div className="flex justify-between text-bro-cyan">
                  <span>Cross-Border ACE/ACI Filing</span>
                  <span className="tabular-nums">{fmtMoney(estimateResp.estimate.customsBrokerageCents, estimateResp.estimate.currency)}</span>
                </div>
              )}
              {estimateResp.estimate.accessorialBreakdown.map((acc) => (
                <div key={acc.code} className="flex justify-between text-[11px]">
                  <span className="text-slate-300 truncate pr-2">{acc.label}</span>
                  <span className="tabular-nums shrink-0">{fmtMoney(acc.amountCents, estimateResp.estimate.currency)}</span>
                </div>
              ))}
            </div>

            {estimateResp.recommendedPort && (
              <div className="p-3.5 rounded-2xl bg-bro-cyan/[0.06] border border-bro-cyan/25 font-mono text-xs space-y-1">
                <div className="flex items-center gap-1.5 text-bro-cyan font-bold">
                  <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Primary Border Port: {estimateResp.recommendedPort.crossingName}</span>
                </div>
                <div className="text-slate-300 text-[11px]">
                  CBP Port #{estimateResp.recommendedPort.cbpCode} · Live Wait:{' '}
                  <strong className="text-white tabular-nums">
                    {estimateResp.recommendedPort.waitMinutes !== null
                      ? `${estimateResp.recommendedPort.waitMinutes} min`
                      : 'Nominal'}
                  </strong>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/[0.08] font-mono text-xs">
              <div className="p-3 rounded-2xl bg-[#060912] border border-white/[0.08] flex items-center gap-2.5">
                <Leaf className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                <div>
                  <div className="text-slate-300 text-[11px]">SmartWay CO₂e</div>
                  <div className="text-emerald-300 font-bold tabular-nums">{estimateResp.estimate.co2Kg} kg</div>
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-[#060912] border border-white/[0.08] flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-bro-gold shrink-0" aria-hidden="true" />
                <div>
                  <div className="text-slate-300 text-[11px]">Tax Status</div>
                  <div className="text-white font-bold">
                    {estimateResp.estimate.isCrossBorder ? '0% Zero-Rated' : 'Domestic'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-12 text-center font-mono text-xs text-slate-300">
            Computing highway distance &amp; live lane tariff…
          </div>
        )}
      </aside>
    </div>
  );
}
