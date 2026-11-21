import { useState, useEffect, useRef } from 'react';
import {
  Menu,
  X,
  Search,
  Compass,
  Calculator,
  ShieldCheck,
  Truck,
  Building2,
  Radio,
  Lock,
  LogOut,
} from 'lucide-react';
import { canAccessRoute, defaultHomeForRole, isOpsRole, type UserRole } from '@bro/contracts';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

interface NavLinkItem {
  href: string;
  label: string;
}

interface MobileNavDrawerProps {
  currentPath: string;
  userRole?: string | null;
  userName?: string | null;
}

const PUBLIC_LINKS: NavLinkItem[] = [
  { href: '/', label: 'Command Center' },
  { href: '/quote', label: 'Instant Quote Engine' },
  { href: '/customs', label: 'Border & Customs' },
  { href: '/verify', label: 'eBOL Crypto Verifier' },
  { href: '/apply', label: 'Carrier Onboarding' },
];

export default function MobileNavDrawer({ currentPath, userRole, userName }: MobileNavDrawerProps) {
  const [open, setOpen] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const { mounted, visible, containerRef } = useModalFocusTrap<HTMLDivElement, HTMLButtonElement>({
    open,
    onClose: () => setOpen(false),
    initialFocusRef: closeBtnRef,
  });

  useEffect(() => {
    const onExternalOpen = () => setOpen(true);
    window.addEventListener('bro:open-mobile-nav', onExternalOpen);
    return () => window.removeEventListener('bro:open-mobile-nav', onExternalOpen);
  }, []);

  const isAuthenticated = Boolean(userRole && userRole !== 'visitor');
  const safeRole: UserRole = (userRole as UserRole | null | undefined) ?? 'visitor';
  const canShipper = isAuthenticated && canAccessRoute(safeRole, '/portal/shipper');
  const canDriver = isAuthenticated && canAccessRoute(safeRole, '/portal/driver');
  const canOps = isAuthenticated && isOpsRole(safeRole);
  const homeHref = isAuthenticated ? defaultHomeForRole(safeRole) : '/login';

  const handleOpenSearch = () => {
    setOpen(false);
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(
      () => {
        window.dispatchEvent(new CustomEvent('bro:open-command-palette'));
      },
      reduced ? 0 : 230,
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="lg:hidden min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-slate-100 hover:bg-white/[0.12] hover:border-white/30 transition-colors cursor-pointer shrink-0"
      >
        <Menu className="w-4 h-4" />
      </button>

      {mounted && (
        <div
          ref={containerRef}
          className="fixed inset-0 z-[100] lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Mobile Navigation"
        >
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-md bro-modal-backdrop"
            data-visible={visible ? 'true' : 'false'}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="fixed right-0 top-0 bottom-0 w-80 max-w-[88vw] bg-[#090d18]/95 backdrop-blur-2xl border-l border-white/15 p-5 sm:p-6 flex flex-col justify-between z-10 overflow-y-auto bro-drawer-panel"
            data-visible={visible ? 'true' : 'false'}
          >
            <div className="space-y-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div>
                  <span className="font-mono text-xs uppercase tracking-widest text-bro-cyan font-bold">
                    #BRO Navigation
                  </span>
                  {isAuthenticated && userName && (
                    <div className="text-xs text-slate-300 mt-0.5 truncate max-w-[190px]">
                      {userName} · <span className="text-bro-gold capitalize">{safeRole.replace(/_/g, ' ')}</span>
                    </div>
                  )}
                </div>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation menu"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-white/10 bg-[#0b1120] text-slate-300 hover:text-white hover:border-white/25 transition-colors cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <button
                type="button"
                onClick={handleOpenSearch}
                className="w-full min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-white/10 bg-[#0b1120] hover:border-bro-cyan/40 text-slate-200 hover:text-white text-xs font-medium transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2.5">
                  <Search className="w-4 h-4 text-bro-cyan shrink-0" />
                  <span>Command Search</span>
                </span>
                <kbd className="px-2 py-0.5 rounded-md bg-white/10 font-mono text-[11px] text-slate-300">
                  ⌘K
                </kbd>
              </button>

              <div className="space-y-1.5">
                <p className="font-mono text-[11px] uppercase tracking-wider text-slate-400 px-1 pb-1">
                  Public Corridor Tools
                </p>
                {PUBLIC_LINKS.map((item) => {
                  const active =
                    item.href === '/' ? currentPath === '/' : currentPath.startsWith(item.href);
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={`min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-colors border ${
                        active
                          ? 'bg-bro-cyan/15 text-bro-cyan border-bro-cyan/40 font-semibold'
                          : 'bg-[#0b1120]/70 border-white/[0.06] text-slate-200 hover:bg-[#0b1120] hover:border-white/20 hover:text-white'
                      }`}
                    >
                      {item.href === '/' && <Compass className="w-4 h-4 shrink-0" />}
                      {item.href === '/quote' && <Calculator className="w-4 h-4 shrink-0" />}
                      {item.href === '/customs' && <Radio className="w-4 h-4 shrink-0" />}
                      {item.href === '/verify' && <ShieldCheck className="w-4 h-4 shrink-0" />}
                      {item.href === '/apply' && <Truck className="w-4 h-4 shrink-0" />}
                      <span>{item.label}</span>
                    </a>
                  );
                })}
              </div>

              <div className="space-y-2 pt-4 border-t border-white/10">
                <p className="font-mono text-[11px] uppercase tracking-wider text-slate-400 px-1">
                  {isAuthenticated ? 'Authorized Portals' : 'Dual-Portal Access'}
                </p>

                {(!isAuthenticated || canShipper) && (
                  <a
                    href={isAuthenticated ? '/portal/shipper' : '/login?next=%2Fportal%2Fshipper'}
                    onClick={() => setOpen(false)}
                    className="min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-white/10 bg-[#0b1120] text-slate-200 hover:border-bro-cyan/50 hover:text-white text-xs font-medium transition-colors"
                  >
                    <span className="flex items-center gap-3">
                      <Building2 className="w-4 h-4 text-bro-cyan shrink-0" />
                      <span>Shipper Portal</span>
                    </span>
                    {!isAuthenticated && (
                      <span className="text-[11px] font-mono text-slate-400">Sign In</span>
                    )}
                  </a>
                )}

                {(!isAuthenticated || canDriver) && (
                  <a
                    href={isAuthenticated ? '/portal/driver' : '/login?next=%2Fportal%2Fdriver'}
                    onClick={() => setOpen(false)}
                    className="min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-white/10 bg-[#0b1120] text-slate-200 hover:border-bro-gold/50 hover:text-white text-xs font-medium transition-colors"
                  >
                    <span className="flex items-center gap-3">
                      <Truck className="w-4 h-4 text-bro-gold shrink-0" />
                      <span>Driver Offline PWA</span>
                    </span>
                    {!isAuthenticated && (
                      <span className="text-[11px] font-mono text-slate-400">Sign In</span>
                    )}
                  </a>
                )}

                {(!isAuthenticated || canOps) && (
                  <a
                    href={isAuthenticated ? '/ops' : '/login?next=%2Fops'}
                    onClick={() => setOpen(false)}
                    className="min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-bro-gold/30 bg-bro-gold/10 text-bro-gold hover:bg-bro-gold/20 text-xs font-semibold transition-colors"
                  >
                    <span className="flex items-center gap-3">
                      <Lock className="w-4 h-4 shrink-0" />
                      <span>Ops Command Tower</span>
                    </span>
                    {!isAuthenticated && (
                      <span className="text-[11px] font-mono text-bro-gold/80">Staff</span>
                    )}
                  </a>
                )}
              </div>
            </div>

            <div className="pt-4 mt-5 border-t border-white/10 space-y-2.5">
              {isAuthenticated ? (
                <>
                  <a
                    href={homeHref}
                    onClick={() => setOpen(false)}
                    className="min-h-[44px] flex items-center justify-center w-full text-center px-4 py-2.5 rounded-xl bg-bro-cyan hover:bg-bro-cyan/90 text-black text-xs font-bold tracking-tight transition-colors"
                  >
                    Open Workspace ({safeRole.replace(/_/g, ' ')})
                  </a>
                  <form method="POST" action="/api/auth/logout" data-astro-reload>
                    <button
                      type="submit"
                      className="min-h-[44px] flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl border border-rose-500/35 bg-rose-950/30 hover:bg-rose-950/60 text-rose-200 text-xs font-medium transition-colors cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Sign Out</span>
                    </button>
                  </form>
                </>
              ) : (
                <a
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="min-h-[44px] flex items-center justify-center w-full text-center px-4 py-2.5 rounded-xl bg-bro-cyan hover:bg-bro-cyan/90 text-black text-xs font-bold tracking-tight transition-colors"
                >
                  Portal Sign-In
                </a>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
