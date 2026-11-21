import React, { useState, useEffect, useMemo } from 'react';
import { Search, Command, ArrowRight, Calculator, ShieldCheck, Globe, Truck, Building2, Lock, FileText } from 'lucide-react';

interface CommandAction {
  id: string;
  label: string;
  hint: string;
  href: string;
  category: string;
  icon: 'quote' | 'customs' | 'verify' | 'driver' | 'shipper' | 'ops' | 'globe';
}

const STATIC_ACTIONS: CommandAction[] = [
  { id: 'home', label: '3D North American Command Globe', hint: '/', href: '/', category: 'Public', icon: 'globe' },
  { id: 'quote', label: 'Instant Freight Rate Calculator', hint: '/quote', href: '/quote', category: 'Public', icon: 'quote' },
  { id: 'customs', label: 'Live CBP/CBSA Border Wait Times & ACE/ACI', hint: '/customs', href: '/customs', category: 'Public', icon: 'customs' },
  { id: 'verify', label: 'Cryptographic eBOL Verifier & Tamper Lab', hint: '/verify', href: '/verify', category: 'Public', icon: 'verify' },
  { id: 'apply', label: 'Carrier Onboarding & FMCSA DOT Check', hint: '/apply', href: '/apply', category: 'External Portal', icon: 'driver' },
  { id: 'shipper', label: 'Customer / Shipper Self-Serve Portal', hint: '/portal/shipper', href: '/portal/shipper', category: 'Portal 1', icon: 'shipper' },
  { id: 'driver', label: 'Driver Mobile PWA (Docs, DVIR, Pay)', hint: '/portal/driver', href: '/portal/driver', category: 'Portal 1', icon: 'driver' },
  { id: 'ops', label: 'Ops Control Tower Overview', hint: '/ops', href: '/ops', category: 'Portal 2 (Internal)', icon: 'ops' },
  { id: 'dispatch', label: 'Dispatch Load Board & EDI 204/990/214', hint: '/ops/dispatch', href: '/ops/dispatch', category: 'Portal 2 (Internal)', icon: 'ops' },
  { id: 'docs', label: 'AI Document OCR Verification Queue', hint: '/ops/documents', href: '/ops/documents', category: 'Portal 2 (Internal)', icon: 'customs' },
  { id: 'ops-customs', label: 'Cross-Border Customs & CARM Desk', hint: '/ops/customs', href: '/ops/customs', category: 'Portal 2 (Internal)', icon: 'customs' },
  { id: 'billing', label: 'Billing, Factoring Packets, Settlements & IFTA', hint: '/ops/billing', href: '/ops/billing', category: 'Portal 2 (Internal)', icon: 'quote' },
  { id: 'fleet', label: 'Fleet Safety, DVIR & Weibull-Cox Twin', hint: '/ops/fleet', href: '/ops/fleet', category: 'Portal 2 (Internal)', icon: 'driver' },
  { id: 'admin', label: 'Admin RBAC & Autonomous Agent Controls', hint: '/ops/admin', href: '/ops/admin', category: 'Portal 2 (Admin)', icon: 'ops' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const dynamicIntent = useMemo<CommandAction | null>(() => {
    const q = query.trim();
    if (!q) return null;

    // Natural-language Quote Intent: "quote 38000 reefer PEI to Boston"
    if (/^quote\b/i.test(q)) {
      const equipMatch = q.match(/\b(reefer|flatbed|dry[\s_-]?van)\b/i);
      const weightMatch = q.match(/\b(\d{4,5})\b/);
      const equip = equipMatch ? equipMatch[1].toLowerCase().replace(/[\s-]/, '_') : 'reefer';
      const weight = weightMatch ? weightMatch[1] : '36000';
      return {
        id: 'intent-quote',
        label: `Launch Rate Engine: ${equip.toUpperCase()} (${Number(weight).toLocaleString()} lbs)`,
        hint: `/quote?equipment=${equip}&weight=${weight}`,
        href: `/quote?equipment=${encodeURIComponent(equip)}&weight=${encodeURIComponent(weight)}`,
        category: 'Smart Intent',
        icon: 'quote',
      };
    }

    // eBOL Verify Intent: "verify load_9948"
    const verifyMatch = q.match(/^verify\s+([a-zA-Z0-9_-]+)/i);
    if (verifyMatch) {
      return {
        id: 'intent-verify',
        label: `Cryptographically Verify eBOL: ${verifyMatch[1]}`,
        hint: `/verify/${verifyMatch[1]}`,
        href: `/verify/${encodeURIComponent(verifyMatch[1])}`,
        category: 'Smart Intent',
        icon: 'verify',
      };
    }

    // FMCSA DOT Lookup Intent: "dot 3849201"
    const dotMatch = q.match(/^(?:dot|usdot)\s+(\d{4,8})/i);
    if (dotMatch) {
      return {
        id: 'intent-dot',
        label: `Verify FMCSA Carrier USDOT #${dotMatch[1]}`,
        hint: `/apply?dot=${dotMatch[1]}`,
        href: `/apply?dot=${encodeURIComponent(dotMatch[1])}`,
        category: 'Smart Intent',
        icon: 'driver',
      };
    }

    return null;
  }, [query]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? STATIC_ACTIONS.filter(
          (a) =>
            a.label.toLowerCase().includes(q) ||
            a.category.toLowerCase().includes(q) ||
            a.href.toLowerCase().includes(q),
        )
      : STATIC_ACTIONS;
    return dynamicIntent ? [dynamicIntent, ...base] : base;
  }, [query, dynamicIntent]);

  const renderIcon = (kind: CommandAction['icon']) => {
    switch (kind) {
      case 'quote': return <Calculator className="w-4 h-4 text-bro-gold" />;
      case 'customs': return <FileText className="w-4 h-4 text-bro-cyan" />;
      case 'verify': return <ShieldCheck className="w-4 h-4 text-emerald-400" />;
      case 'driver': return <Truck className="w-4 h-4 text-bro-gold" />;
      case 'shipper': return <Building2 className="w-4 h-4 text-bro-cyan" />;
      case 'ops': return <Lock className="w-4 h-4 text-bro-gold" />;
      default: return <Globe className="w-4 h-4 text-bro-cyan" />;
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open Command Palette (Cmd+K)"
        className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.06] hover:bg-white/[0.12] hover:border-white/30 text-slate-300 hover:text-white text-xs transition-all cursor-pointer"
      >
        <Search className="w-3.5 h-3.5 text-bro-cyan" />
        <span className="font-medium">Search</span>
        <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-slate-200">
          <Command className="w-2.5 h-2.5" />K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[120] flex items-start justify-center pt-[12vh] px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Freight Command Palette"
        >
          <div className="fixed inset-0 bg-black/75 backdrop-blur-md" onClick={() => setOpen(false)} />
          <div className="relative z-10 w-full max-w-xl liquid-glass rounded-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10">
              <Search className="w-4 h-4 text-bro-cyan shrink-0" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Type a route or command (e.g. "quote 38000 reefer", "dot 123456", "verify load_9948")'
                className="w-full bg-transparent text-sm text-white placeholder-slate-500 outline-none font-mono"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-2 py-0.5 rounded border border-white/10 font-mono text-[10px] text-slate-400 hover:text-white cursor-pointer"
              >
                ESC
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-white/5 p-2">
              {results.length === 0 ? (
                <div className="p-6 text-center font-mono text-xs text-slate-500">
                  No matching portal or freight command found.
                </div>
              ) : (
                results.map((item) => (
                  <a
                    key={item.id}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded hover:bg-bro-steel/80 transition-colors group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {renderIcon(item.icon)}
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-white group-hover:text-bro-cyan truncate">
                          {item.label}
                        </div>
                        <div className="font-mono text-[10px] text-slate-500 truncate">
                          {item.category} · {item.hint}
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-bro-cyan shrink-0" />
                  </a>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
