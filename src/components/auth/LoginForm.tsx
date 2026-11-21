import React, { useState } from 'react';
import { ShieldCheck, KeyRound, Mail, ArrowRight, Lock, Truck, Building2, Radio } from 'lucide-react';
import { canAccessRoute, type UserRole } from '@bro/contracts';

interface LoginFormProps {
  nextPath?: string;
  isDev?: boolean;
}

interface AuthResponsePayload {
  error?: string;
  redirectTo?: string;
  user?: {
    role?: UserRole;
  };
}

function resolveSafePostLoginDestination(
  rawNext: string,
  role: UserRole | undefined,
  fallbackRedirect: string | undefined,
): string {
  const trimmed = rawNext.trim();
  const isSafeRelativePath =
    trimmed.startsWith('/') &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/\\') &&
    !trimmed.includes('\\') &&
    !/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);

  if (isSafeRelativePath) {
    try {
      const parsed = new URL(trimmed, 'https://brotransport.local');
      if (parsed.origin === 'https://brotransport.local') {
        const safePath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        if (role && canAccessRoute(role, parsed.pathname)) {
          return safePath;
        }
      }
    } catch {
      // Fall through to role default home
    }
  }

  return fallbackRedirect || '/';
}

export default function LoginForm({ nextPath = '', isDev = false }: LoginFormProps) {
  const [mode, setMode] = useState<'password' | 'otp' | 'register'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpRequested, setOtpRequested] = useState(false);
  const [portalRole, setPortalRole] = useState<'shipper_user' | 'carrier_driver'>('shipper_user');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      if (mode === 'password') {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = (await res.json()) as AuthResponsePayload;
        if (!res.ok) throw new Error(data.error || 'Authentication rejected.');
        window.location.href = resolveSafePostLoginDestination(nextPath, data.user?.role, data.redirectTo);
      } else if (mode === 'otp') {
        if (!otpRequested) {
          const res = await fetch('/api/auth/otp/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          const data = (await res.json()) as { error?: string; devCode?: string };
          if (!res.ok) throw new Error(data.error || 'Unable to dispatch OTP code.');
          setOtpRequested(true);
          setNotice(
            data.devCode
              ? `Verification code dispatched (Local Dev OTP: ${data.devCode}).`
              : 'One-time 6-digit security code sent to your email.',
          );
        } else {
          const res = await fetch('/api/auth/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code: otpCode }),
          });
          const data = (await res.json()) as AuthResponsePayload;
          if (!res.ok) throw new Error(data.error || 'Invalid or expired security code.');
          window.location.href = resolveSafePostLoginDestination(nextPath, data.user?.role, data.redirectTo);
        }
      } else {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, role: portalRole }),
        });
        const data = (await res.json()) as AuthResponsePayload;
        if (!res.ok) throw new Error(data.error || 'Registration failed.');
        window.location.href = resolveSafePostLoginDestination(nextPath, data.user?.role, data.redirectTo);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setLoading(false);
    }
  };

  const handleDevDemoLogin = async (demoEmail: string) => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/dev-impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: demoEmail }),
      });
      const data = (await res.json()) as AuthResponsePayload;
      if (!res.ok) throw new Error(data.error || 'Dev login unavailable.');
      window.location.href = resolveSafePostLoginDestination(nextPath, data.user?.role, data.redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch role.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto surface-ceramic rounded-3xl p-6 sm:p-8 space-y-6">
      <div className="space-y-2 border-b border-white/[0.08] pb-5">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-bro-cyan/10 border border-bro-cyan/30 text-bro-cyan text-xs font-medium">
          <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>Zero-Trust Portal Gateway</span>
        </div>
        <h1 className="text-2xl font-display font-bold text-white tracking-tight">
          #BRO Command Sign-In
        </h1>
        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
          Unified RBAC authentication for Shippers, Drivers, Dispatchers, Customs Brokers, and Admins.
        </p>
      </div>

      {/* Apple Segmented Mode Control */}
      <div
        role="group"
        aria-label="Authentication Method"
        className="grid grid-cols-3 gap-1.5 p-1.5 bg-[#060912] border border-white/[0.08] rounded-full text-xs"
      >
        <button
          type="button"
          aria-pressed={mode === 'password'}
          onClick={() => { setMode('password'); setError(null); }}
          className={`min-h-[44px] px-3 py-2 rounded-full transition-colors cursor-pointer font-medium ${
            mode === 'password' ? 'bg-white text-black font-semibold shadow-sm' : 'text-slate-300 hover:text-white'
          }`}
        >
          Password
        </button>
        <button
          type="button"
          aria-pressed={mode === 'otp'}
          onClick={() => { setMode('otp'); setOtpRequested(false); setError(null); }}
          className={`min-h-[44px] px-3 py-2 rounded-full transition-colors cursor-pointer font-medium ${
            mode === 'otp' ? 'bg-white text-black font-semibold shadow-sm' : 'text-slate-300 hover:text-white'
          }`}
        >
          Email OTP
        </button>
        <button
          type="button"
          aria-pressed={mode === 'register'}
          onClick={() => { setMode('register'); setError(null); }}
          className={`min-h-[44px] px-3 py-2 rounded-full transition-colors cursor-pointer font-medium ${
            mode === 'register' ? 'bg-bro-gold text-black font-semibold shadow-sm' : 'text-slate-300 hover:text-white'
          }`}
        >
          Register
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'register' && (
          <>
            <fieldset className="space-y-2">
              <legend className="block text-xs font-medium text-slate-300">Account Type</legend>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  aria-pressed={portalRole === 'shipper_user'}
                  onClick={() => setPortalRole('shipper_user')}
                  className={`min-h-[44px] flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl border text-xs font-semibold cursor-pointer transition-colors ${
                    portalRole === 'shipper_user'
                      ? 'border-bro-cyan bg-bro-cyan/15 text-white'
                      : 'border-white/15 bg-[#060912] text-slate-300 hover:text-white hover:border-white/30'
                  }`}
                >
                  <Building2 className="w-4 h-4 shrink-0 text-bro-cyan" aria-hidden="true" />
                  <span>Shipper</span>
                </button>
                <button
                  type="button"
                  aria-pressed={portalRole === 'carrier_driver'}
                  onClick={() => setPortalRole('carrier_driver')}
                  className={`min-h-[44px] flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl border text-xs font-semibold cursor-pointer transition-colors ${
                    portalRole === 'carrier_driver'
                      ? 'border-bro-gold bg-bro-gold/15 text-white'
                      : 'border-white/15 bg-[#060912] text-slate-300 hover:text-white hover:border-white/30'
                  }`}
                >
                  <Truck className="w-4 h-4 shrink-0 text-bro-gold" aria-hidden="true" />
                  <span>Driver / Carrier</span>
                </button>
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <label htmlFor="login-name" className="block text-xs font-medium text-slate-300">
                Full Name
              </label>
              <input
                id="login-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Owen MacLeod"
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </>
        )}

        <div className="space-y-1.5">
          <label htmlFor="login-email" className="block text-xs font-medium text-slate-300">
            Corporate / Driver Email
          </label>
          <div className="relative">
            <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
            />
          </div>
        </div>

        {(mode === 'password' || mode === 'register') && (
          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-xs font-medium text-slate-300">
              {mode === 'register' ? 'Password (min 10 characters)' : 'Password'}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input
                id="login-password"
                type="password"
                required
                minLength={mode === 'register' ? 10 : 8}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </div>
        )}

        {mode === 'otp' && otpRequested && (
          <div className="space-y-1.5">
            <label htmlFor="login-otp" className="block text-xs font-medium text-slate-300">
              6-Digit Security Code
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input
                id="login-otp"
                type="text"
                inputMode="numeric"
                maxLength={6}
                required
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                placeholder="000000"
                className="w-full min-h-[44px] bg-[#060912] border border-bro-cyan/50 rounded-xl pl-10 pr-3.5 py-2.5 text-sm font-mono tracking-widest text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="p-3.5 rounded-xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" aria-live="polite" className="p-3.5 rounded-xl bg-cyan-950/60 border border-bro-cyan/40 text-bro-cyan text-xs font-medium">
            {notice}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className={`w-full min-h-[48px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50 cursor-pointer ${
            mode === 'register'
              ? 'bg-bro-gold hover:bg-amber-300 text-black'
              : 'bg-white hover:bg-bro-ice text-black'
          }`}
        >
          <span>
            {loading
              ? 'Verifying Credentials...'
              : mode === 'register'
                ? 'Create External Portal Account'
                : mode === 'otp' && !otpRequested
                  ? 'Send One-Time Code'
                  : 'Authenticate & Enter Portal'}
          </span>
          <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
        </button>
      </form>

      {isDev && (
        <div className="pt-4 border-t border-white/10 space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium text-bro-gold">
            <Radio className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Local Dev Quick-Role Switch (Disabled in Production)</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5 text-xs">
            <button
              type="button"
              onClick={() => handleDevDemoLogin('admin@brotransport.com')}
              className="min-h-[44px] px-3 py-2 rounded-xl border border-bro-gold/35 bg-[#060912] hover:border-bro-gold text-slate-200 font-medium cursor-pointer text-left transition-colors"
            >
              Super Admin → /ops
            </button>
            <button
              type="button"
              onClick={() => handleDevDemoLogin('dispatch@brotransport.com')}
              className="min-h-[44px] px-3 py-2 rounded-xl border border-bro-cyan/35 bg-[#060912] hover:border-bro-cyan text-slate-200 font-medium cursor-pointer text-left transition-colors"
            >
              Dispatcher → /ops
            </button>
            <button
              type="button"
              onClick={() => handleDevDemoLogin('owen@cavendishvalley.example')}
              className="min-h-[44px] px-3 py-2 rounded-xl border border-white/15 bg-[#060912] hover:border-bro-cyan text-slate-200 font-medium cursor-pointer text-left transition-colors"
            >
              Shipper → /portal/shipper
            </button>
            <button
              type="button"
              onClick={() => handleDevDemoLogin('liam.gallant@brotransport.com')}
              className="min-h-[44px] px-3 py-2 rounded-xl border border-white/15 bg-[#060912] hover:border-bro-gold text-slate-200 font-medium cursor-pointer text-left transition-colors"
            >
              Driver → /portal/driver
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
