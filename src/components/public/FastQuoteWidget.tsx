import { useState } from 'react';
import { ArrowRight, Calculator, Snowflake, Truck, Layers } from 'lucide-react';

const EQUIPMENT_CHOICES = [
  { id: 'dry_van', label: 'Dry Van', icon: Truck },
  { id: 'reefer', label: 'Reefer', icon: Snowflake },
  { id: 'flatbed', label: 'Flatbed', icon: Layers },
] as const;

export default function FastQuoteWidget() {
  const [equipment, setEquipment] = useState<'dry_van' | 'reefer' | 'flatbed'>('reefer');
  const [origin, setOrigin] = useState('Charlottetown');
  const [dest, setDest] = useState('Boston');

  const targetHref = `/quote?equipment=${encodeURIComponent(equipment)}&origin=${encodeURIComponent(origin)}&dest=${encodeURIComponent(dest)}`;

  return (
    <div className="rounded-3xl surface-ceramic p-6 sm:p-7 flex flex-col justify-between space-y-6 h-full hover:border-bro-gold/40 transition-colors">
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-bro-gold">
            <Calculator className="w-4 h-4" />
            <span>Instant Rate Launcher</span>
          </div>
          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/10 font-mono text-[11px] text-slate-200">
            OSRM + SmartWay
          </span>
        </div>

        <div>
          <h3 className="text-xl font-display font-bold text-white tracking-tight">
            Calculate Door-to-Door Lane Tariff
          </h3>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">
            Real highway routing, automatic nearest border assignment &amp; exact CAD/USD breakdown.
          </p>
        </div>

        {/* Apple-style Segmented Equipment Switcher */}
        <div className="space-y-2">
          <span className="block text-xs font-medium text-slate-200">Equipment Division</span>
          <div className="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-[#060912] border border-white/[0.08]">
            {EQUIPMENT_CHOICES.map(({ id, label, icon: Icon }) => {
              const active = equipment === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setEquipment(id)}
                  aria-pressed={active}
                  className={`min-h-[44px] flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    active
                      ? 'bg-white text-black font-semibold shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-white/[0.05]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="fq-origin" className="block text-xs font-medium text-slate-200">
              Origin Hub
            </label>
            <select
              id="fq-origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-white outline-none focus:border-bro-gold"
            >
              <option value="Charlottetown">Charlottetown, PE (HQ)</option>
              <option value="Halifax">Halifax, NS (Port)</option>
              <option value="Moncton">Moncton, NB (Atlantic)</option>
              <option value="Montreal">Montreal, QC</option>
              <option value="Toronto">Toronto, ON</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="fq-dest" className="block text-xs font-medium text-slate-200">
              Destination Hub
            </label>
            <select
              id="fq-dest"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-white outline-none focus:border-bro-gold"
            >
              <option value="Boston">Boston, MA</option>
              <option value="Newark">New York / Newark, NJ</option>
              <option value="Detroit">Detroit, MI</option>
              <option value="Chicago">Chicago, IL</option>
              <option value="Toronto">Toronto, ON</option>
            </select>
          </div>
        </div>
      </div>

      <a
        href={targetHref}
        className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 py-3 rounded-full bg-bro-gold hover:bg-amber-400 text-black font-semibold text-sm tracking-tight transition-colors"
      >
        <span>Compute Exact Lane Rate</span>
        <ArrowRight className="w-4 h-4" aria-hidden="true" />
      </a>
    </div>
  );
}
