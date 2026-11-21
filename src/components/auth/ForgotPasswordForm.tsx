import React, { useState } from 'react';
import { ShieldCheck, Mail, ArrowRight, KeyRound } from 'lucide-react';

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);
  const [devOtpCode, setDevOtpCode] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setDevResetUrl(null);
    setDevOtpCode(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        devResetUrl?: string;
        devOtpCode?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Unable to process password reset request.');

      setMessage(data.message || 'If an active account exists, a password reset link was dispatched.');
      if (data.devResetUrl) setDevResetUrl(data.devResetUrl);
      if (data.devOtpCode) setDevOtpCode(data.devOtpCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto surface-ceramic rounded-3xl p-6 sm:p-8 space-y-6">
      <div className="space-y-2 border-b border-white/[0.08] pb-5">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-bro-cyan/10 border border-bro-cyan/30 text-bro-cyan text-xs font-medium">
          <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>Zero-Trust Account Recovery</span>
        </div>
        <h1 className="text-2xl font-display font-bold text-white tracking-tight">
          Reset Portal Password
        </h1>
        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
          Enter your corporate, shipper, or driver email to receive a 30-minute cryptographic reset link and recovery code.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="forgot-email" className="block text-xs font-medium text-slate-300">
            Account Email Address
          </label>
          <div className="relative">
            <Mail
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="forgot-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@brotransport.com"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
            />
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium"
          >
            {error}
          </div>
        )}

        {message && (
          <div
            role="status"
            aria-live="polite"
            className="p-3.5 rounded-xl bg-cyan-950/60 border border-bro-cyan/40 text-bro-cyan text-xs font-medium space-y-2"
          >
            <div>{message}</div>
            {devResetUrl && (
              <div className="pt-2 border-t border-bro-cyan/25 space-y-1.5 text-slate-200">
                <div className="text-[11px] uppercase tracking-wider text-bro-gold font-semibold">
                  Local Dev Recovery Link
                </div>
                <a
                  href={devResetUrl}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-white underline hover:text-bro-cyan break-all"
                >
                  Open Password Reset Link →
                </a>
                {devOtpCode && (
                  <div className="font-mono text-xs text-slate-300">
                    Dev 6-Digit OTP: <strong className="text-white">{devOtpCode}</strong>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full min-h-[48px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm bg-white hover:bg-bro-ice text-black transition-colors disabled:opacity-50 cursor-pointer"
        >
          <span>{loading ? 'Dispatching Recovery Link...' : 'Send Password Reset Link'}</span>
          <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
        </button>
      </form>

      <div className="pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs">
        <a href="/login" className="text-slate-300 hover:text-white font-medium">
          ← Return to Sign-In
        </a>
        <a
          href={email ? `/reset-password?email=${encodeURIComponent(email)}` : '/reset-password'}
          className="inline-flex items-center gap-1 text-bro-cyan hover:text-cyan-300 font-medium"
        >
          <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Have a 6-digit code?</span>
        </a>
      </div>
    </div>
  );
}
