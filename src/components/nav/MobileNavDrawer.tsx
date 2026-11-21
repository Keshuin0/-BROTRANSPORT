import React, { useState, useEffect } from 'react';
import { Menu, X, Compass, Calculator, ShieldCheck, Truck, Building2, Radio, Lock } from 'lucide-react';

interface NavLinkItem {
  href: string;
  label: string;
  section?: 'public' | 'portal';
}

interface MobileNavDrawerProps {
  currentPath: string;
  userRole?: string | null;
}

const PUBLIC_LINKS: NavLinkItem[] = [
  { href: '/', label: 'Command Center', section: 'public' },
  { href: '/quote', label: 'Instant Quote Engine', section: 'public' },
  { href: '/customs', label: 'Border & Customs', section: 'public' },
  { href: '/verify', label: 'eBOL Crypto Verifier', section: 'public' },
  { href: '/apply', label: 'Carrier Onboarding', section: 'public' },
];

export default function MobileNavDrawer({ currentPath, userRole }: MobileNavDrawerProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="md:hidden inline-flex items-center justify-center p-2 rounded-full border border-white/15 bg-white/[0.06] text-slate-100 hover:border-white/30 transition-colors cursor-pointer"
      >
        <Menu className="w-4 h-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Mobile Navigation"
        >
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-md"
            onClick={() => setOpen(false)}
          />
          <aside className="fixed right-0 top-0 bottom-0 w-80 max-w-[85vw] bg-[#090d18]/95 backdrop-blur-2xl border-l border-white/15 p-6 flex flex-col justify-between z-10 overflow-y-auto">
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <span className="font-mono text-xs uppercase tracking-widest text-bro-cyan font-bold">
                  #BRO NAVIGATION
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation menu"
                  className="p-1.5 rounded border border-white/10 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-1.5">
                <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500 px-2 pb-1">
                  Public Corridor Tools
                </p>
                {PUBLIC_LINKS.map((item) => {
                  const active = currentPath === item.href;
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded font-mono text-xs uppercase tracking-wider transition-colors ${
                        active
                          ? 'bg-bro-cyan/15 text-bro-cyan border border-bro-cyan/40 font-bold'
                          : 'text-slate-300 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {item.href === '/' && <Compass className="w-4 h-4" />}
                      {item.href === '/quote' && <Calculator className="w-4 h-4" />}
                      {item.href === '/customs' && <Radio className="w-4 h-4" />}
                      {item.href === '/verify' && <ShieldCheck className="w-4 h-4" />}
                      {item.href === '/apply' && <Truck className="w-4 h-4" />}
                      <span>{item.label}</span>
                    </a>
                  );
                })}
              </div>

              <div className="space-y-2 pt-4 border-t border-white/10">
                <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500 px-2">
                  Dual-Portal Access
                </p>
                <a
                  href="/portal/shipper"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded border border-white/10 bg-bro-steel/60 text-slate-200 hover:border-bro-cyan text-xs font-mono uppercase"
                >
                  <Building2 className="w-4 h-4 text-bro-cyan" />
                  <span>Customer / Shipper Portal</span>
                </a>
                <a
                  href="/portal/driver"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded border border-white/10 bg-bro-steel/60 text-slate-200 hover:border-bro-gold text-xs font-mono uppercase"
                >
                  <Truck className="w-4 h-4 text-bro-gold" />
                  <span>Driver Offline PWA Portal</span>
                </a>
                <a
                  href="/ops"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded border border-bro-gold/30 bg-bro-gold/10 text-bro-gold hover:bg-bro-gold/20 text-xs font-mono uppercase font-bold"
                >
                  <Lock className="w-4 h-4" />
                  <span>Ops & Admin Tower</span>
                </a>
              </div>
            </div>

            <div className="pt-4 border-t border-white/10">
              <a
                href={userRole ? '/portal/shipper' : '/login'}
                onClick={() => setOpen(false)}
                className="block w-full text-center py-2.5 rounded bg-bro-cyan text-black font-mono text-xs font-bold uppercase tracking-wider"
              >
                {userRole ? `Signed In (${userRole})` : 'Portal Sign-In'}
              </a>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
