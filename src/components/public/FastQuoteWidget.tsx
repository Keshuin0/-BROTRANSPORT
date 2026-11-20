import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';

export default function FastQuoteWidget() {
  const [equipment, setEquipment] = useState('reefer');
  const [origin, setOrigin] = useState('Charlottetown');
  const [dest, setDest] = useState('Boston');

  const targetHref = `/quote?equipment=${encodeURIComponent(equipment)}&origin=${encodeURIComponent(origin)}&dest=${encodeURIComponent(dest)}`;

  return (
    <div className="rounded-lg border border-white/10 bg-bro-steel/40 p-6 flex flex-col justify-between space-y-5 hover:border-bro-gold/50 transition-colors">
      <div className="space-y-4">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase">
          <span className="text-slate-400">02 // FAST QUOTE LAUNCHER</span>
          <span className="text-bro-gold font-bold">INSTANT OSRM TARIFF</span>
        </div>

        <div className="space-y-3 font-mono text-xs">
          <div className="space-y-1">
            <label htmlFor="fq-equip" className="block text-[10px] text-slate-400 uppercase">
              Equipment Class
            </label>
            <select
              id="fq-equip"
              value={equipment}
              onChange={(e) => setEquipment(e.target.value)}
              className="w-full bg-bro-obsidian/80 border border-white/10 rounded px-3 py-2 text-white outline-none focus:border-bro-gold"
            >
              <option value="dry_van">53ft Enclosed Dry Van</option>
              <option value="reefer">53ft Cold-Chain Reefer</option>
              <option value="flatbed">53ft Open-Deck Flatbed</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="fq-origin" className="block text-[10px] text-slate-400 uppercase">
              Origin Hub
            </label>
            <select
              id="fq-origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-full bg-bro-obsidian/80 border border-white/10 rounded px-3 py-2 text-white outline-none focus:border-bro-gold"
            >
              <option value="Charlottetown">Charlottetown, PE (PEI HQ)</option>
              <option value="Halifax">Halifax, NS (Port Terminal)</option>
              <option value="Moncton">Moncton, NB (Atlantic Hub)</option>
              <option value="Montreal">Montreal, QC</option>
              <option value="Toronto">Toronto, ON</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="fq-dest" className="block text-[10px] text-slate-400 uppercase">
              Destination Hub
            </label>
            <select
              id="fq-dest"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              className="w-full bg-bro-obsidian/80 border border-white/10 rounded px-3 py-2 text-white outline-none focus:border-bro-gold"
            >
              <option value="Boston">Boston, MA (U.S. Northeast)</option>
              <option value="Newark">New York / Newark, NJ</option>
              <option value="Detroit">Detroit, MI (Ambassador / Gordie Howe)</option>
              <option value="Chicago">Chicago, IL (Midwest Hub)</option>
              <option value="Toronto">Toronto, ON (Domestic Canada)</option>
            </select>
          </div>
        </div>
      </div>

      <a
        href={targetHref}
        className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded bg-bro-gold hover:bg-bro-gold/90 text-black font-mono text-xs font-bold uppercase tracking-wider transition-colors"
      >
        <span>Calculate Exact Lane Rate</span>
        <ArrowRight className="w-4 h-4" />
      </a>
    </div>
  );
}
