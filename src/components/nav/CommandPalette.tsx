import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search,
  Command,
  ArrowRight,
  Calculator,
  ShieldCheck,
  Globe,
  Truck,
  Building2,
  Lock,
  FileText,
} from 'lucide-react';
import { canAccessRoute, type UserRole } from '@bro/contracts';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

interface CommandAction {
  id: string;
  label: string;
  hint: string;
  href: string;
  category: string;
  icon: 'quote' | 'customs' | 'verify' | 'driver' | 'shipper' | 'ops' | 'globe';
  protectedRoute?: boolean;
}

interface CommandPaletteProps {
  userRole?: string | null;
  showMobileIcon?: boolean;
}

const STATIC_ACTIONS: CommandAction[] = [
  { id: 'home', label: '3D North American Command Globe', hint: '/', href: '/', category: 'Public', icon: 'globe' },
  { id: 'quote', label: 'Instant Freight Rate Calculator', hint: '/quote', href: '/quote', category: 'Public', icon: 'quote' },
  { id: 'customs', label: 'Live CBP/CBSA Border Wait Times & ACE/ACI', hint: '/customs', href: '/customs', category: 'Public', icon: 'customs' },
  { id: 'verify', label: 'Cryptographic eBOL Verifier & Tamper Lab', hint: '/verify', href: '/verify', category: 'Public', icon: 'verify' },
  { id: 'apply', label: 'Carrier Onboarding & FMCSA DOT Check', hint: '/apply', href: '/apply', category: 'External Portal', icon: 'driver' },
  { id: 'shipper', label: 'Customer / Shipper Self-Serve Portal', hint: '/portal/shipper', href: '/portal/shipper', category: 'Portal 1', icon: 'shipper', protectedRoute: true },
  { id: 'driver', label: 'Driver Mobile PWA (Docs, DVIR, Pay)', hint: '/portal/driver', href: '/portal/driver', category: 'Portal 1', icon: 'driver', protectedRoute: true },
  { id: 'ops', label: 'Ops Control Tower Overview', hint: '/ops', href: '/ops', category: 'Portal 2 (Internal)', icon: 'ops', protectedRoute: true },
  { id: 'dispatch', label: 'Dispatch Load Board & EDI 204/990/214', hint: '/ops/dispatch', href: '/ops/dispatch', category: 'Portal 2 (Internal)', icon: 'ops', protectedRoute: true },
  { id: 'docs', label: 'AI Document OCR Verification Queue', hint: '/ops/documents', href: '/ops/documents', category: 'Portal 2 (Internal)', icon: 'customs', protectedRoute: true },
  { id: 'ops-customs', label: 'Cross-Border Customs & CARM Desk', hint: '/ops/customs', href: '/ops/customs', category: 'Portal 2 (Internal)', icon: 'customs', protectedRoute: true },
  { id: 'billing', label: 'Billing, Factoring Packets, Settlements & IFTA', hint: '/ops/billing', href: '/ops/billing', category: 'Portal 2 (Internal)', icon: 'quote', protectedRoute: true },
  { id: 'fleet', label: 'Fleet Safety, DVIR & Weibull-Cox Twin', hint: '/ops/fleet', href: '/ops/fleet', category: 'Portal 2 (Internal)', icon: 'driver', protectedRoute: true },
  { id: 'admin', label: 'Admin RBAC & Autonomous Agent Controls', hint: '/ops/admin', href: '/ops/admin', category: 'Portal 2 (Admin)', icon: 'ops', protectedRoute: true },
];

export default function CommandPalette({ userRole, showMobileIcon = false }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const { mounted, visible, containerRef } = useModalFocusTrap<HTMLDivElement, HTMLInputElement>({
    open,
    onClose: () => setOpen(false),
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onExternalOpen = () => {
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('bro:open-command-palette', onExternalOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('bro:open-command-palette', onExternalOpen);
    };
  }, []);

  const scopedActions = useMemo(() => {
    if (userRole === undefined) return STATIC_ACTIONS;
    const isAuthenticated = Boolean(userRole && userRole !== 'visitor');
    const safeRole = (userRole as UserRole | null) ?? 'visitor';

    if (isAuthenticated) {
      return STATIC_ACTIONS.filter((action) => canAccessRoute(safeRole, action.href));
    }

    return STATIC_ACTIONS.map((action) =>
      action.protectedRoute
        ? {
            ...action,
            href: `/login?next=${encodeURIComponent(action.href)}`,
            category: 'Sign-In Required',
          }
        : action,
    );
  }, [userRole]);

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
      ? scopedActions.filter(
          (a) =>
            a.label.toLowerCase().includes(q) ||
            a.category.toLowerCase().includes(q) ||
            a.hint.toLowerCase().includes(q),
        )
      : scopedActions;
    return dynamicIntent ? [dynamicIntent, ...base] : base;
  }, [query, dynamicIntent, scopedActions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open || results.length === 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, results.length]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length > 0) {
        setActiveIndex((prev) => (prev + 1) % results.length);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) {
        setActiveIndex((prev) => (prev - 1 + results.length) % results.length);
      }
      return;
    }

    if (e.key === 'Home' && results.length > 0) {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (e.key === 'End' && results.length > 0) {
      e.preventDefault();
      setActiveIndex(results.length - 1);
      return;
    }

    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      const targetIndex = Math.min(activeIndex, results.length - 1);
      const anchor = itemRefs.current[targetIndex];
      if (anchor) {
        anchor.click();
      } else {
        const target = results[targetIndex];
        setOpen(false);
        if (target) window.location.assign(target.href);
      }
    }
  };

  const renderIcon = (kind: CommandAction['icon']) => {
    switch (kind) {
      case 'quote': return <Calculator className="w-4 h-4 text-bro-gold shrink-0" />;
      case 'customs': return <FileText className="w-4 h-4 text-bro-cyan shrink-0" />;
      case 'verify': return <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />;
      case 'driver': return <Truck className="w-4 h-4 text-bro-gold shrink-0" />;
      case 'shipper': return <Building2 className="w-4 h-4 text-bro-cyan shrink-0" />;
      case 'ops': return <Lock className="w-4 h-4 text-bro-gold shrink-0" />;
      default: return <Globe className="w-4 h-4 text-bro-cyan shrink-0" />;
    }
  };

  const activeItem = results[activeIndex];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open Command Palette (Cmd+K)"
        className={`${
          showMobileIcon ? 'inline-flex' : 'hidden sm:inline-flex'
        } items-center justify-center gap-2 px-3 sm:px-3.5 min-h-[44px] min-w-[44px] rounded-full border border-white/15 bg-white/[0.06] hover:bg-white/[0.12] hover:border-white/30 text-slate-200 hover:text-white text-xs transition-colors cursor-pointer whitespace-nowrap shrink-0`}
      >
        <Search className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-bro-cyan shrink-0" />
        <span className="hidden sm:inline font-medium">Search</span>
        <kbd className="hidden md:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-slate-200">
          <Command className="w-2.5 h-2.5" />K
        </kbd>
      </button>

      {mounted && (
        <div
          ref={containerRef}
          className="fixed inset-0 z-[120] flex items-start justify-center pt-[10vh] sm:pt-[12vh] px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Freight Command Palette"
        >
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-md bro-modal-backdrop"
            data-visible={visible ? 'true' : 'false'}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="relative z-10 w-full max-w-xl liquid-glass rounded-2xl overflow-hidden bro-modal-panel"
            data-visible={visible ? 'true' : 'false'}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-[#0b1120]/70">
              <Search className="w-4 h-4 text-bro-cyan shrink-0" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="command-palette-list"
                aria-autocomplete="list"
                aria-activedescendant={activeItem ? `cmd-opt-${activeItem.id}` : undefined}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder='Type a route or command (e.g. "quote 38000 reefer", "dot 123456")'
                className="w-full min-h-[44px] bg-transparent text-sm text-white placeholder-slate-400 outline-none font-mono"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close command palette"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 rounded-xl border border-white/10 bg-[#0b1120] font-mono text-[11px] text-slate-300 hover:text-white hover:border-white/25 transition-colors cursor-pointer shrink-0"
              >
                ESC
              </button>
            </div>

            <div
              id="command-palette-list"
              role="listbox"
              aria-label="Matching freight commands"
              className="max-h-80 overflow-y-auto space-y-1 p-2"
            >
              {results.length === 0 ? (
                <div className="p-6 text-center font-mono text-xs text-slate-400">
                  No matching portal or freight command found.
                </div>
              ) : (
                results.map((item, idx) => {
                  const isActive = idx === activeIndex;
                  return (
                    <a
                      key={item.id}
                      id={`cmd-opt-${item.id}`}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      role="option"
                      aria-selected={isActive}
                      href={item.href}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => setOpen(false)}
                      className={`flex items-center justify-between gap-3 px-3.5 py-2.5 min-h-[48px] rounded-xl border transition-colors group ${
                        isActive
                          ? 'bg-[#0b1120] border-bro-cyan/45 text-white'
                          : 'bg-[#0b1120]/40 border-transparent hover:bg-[#0b1120] hover:border-white/10'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {renderIcon(item.icon)}
                        <div className="min-w-0">
                          <div
                            className={`text-xs font-medium truncate ${
                              isActive ? 'text-bro-cyan' : 'text-slate-100 group-hover:text-bro-cyan'
                            }`}
                          >
                            {item.label}
                          </div>
                          <div className="font-mono text-[11px] text-slate-400 truncate">
                            {item.category} · {item.hint}
                          </div>
                        </div>
                      </div>
                      <ArrowRight
                        className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                          isActive
                            ? 'text-bro-cyan translate-x-0.5'
                            : 'text-slate-400 group-hover:text-bro-cyan'
                        }`}
                      />
                    </a>
                  );
                })
              )}
            </div>

            <div className="border-t border-white/10 px-4 py-2.5 bg-[#070b15]/90 flex items-center justify-between text-[11px] text-slate-400 font-mono">
              <span>↑↓ Navigate · ↵ Launch</span>
              <span>Esc to Close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
