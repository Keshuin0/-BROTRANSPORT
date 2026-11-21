import React, { useState } from 'react';
import { ShieldCheck, Lock, KeyRound, Mail, ArrowRight } from 'lucide-react';
import { defaultHomeForRole, type UserRole } from '@bro/contracts';

interface ResetPasswordFormProps {
  initialToken?: string;
  initialEmail?: string;
}

export default function ResetPasswordForm({
  initialToken = '',
  initialEmail = '',
}: ResetPasswordFormProps) {
  const [tokenOrOtp, setTokenOrOtp] = useState(initialToken);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSixDigitOtp = /^\d{6}$/.test(tokenOrOtp.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 10) {
      setError('New password must be at least 10 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Password confirmation does not match.');
      return;
    }
    if (isSixDigitOtp && !email.trim()) {
      setError('Provide your account email address when resetting with a 6-digit OTP code.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenOrOtp: tokenOrOtp.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          password,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        redirectTo?: string;
        user?: { role?: UserRole };
      };
      if (!res.ok) throw new Error(data.error || 'Password reset failed.');

      window.location.href = data.redirectTo || (data.user?.role ? defaultHomeForRole(data.user.role) : '/');
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
          <span>Zero-Trust Credential Recovery</span>
        </div>
        <h1 className="text-2xl font-display font-bold text-white tracking-tight">
          Confirm Password Reset
        </h1>
        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
          Verify your reset token or 6-digit email OTP code and choose a new 10+ character password.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="reset-token" className="block text-xs font-medium text-slate-300">
            Reset Token or 6-Digit Security Code
          </label>
          <div className="relative">
            <KeyRound
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="reset-token"
              type="text"
              required
              value={tokenOrOtp}
              onChange={(e) => setTokenOrOtp(e.target.value)}
              placeholder="Reset token or 6-digit OTP"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-xs font-mono text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
            />
          </div>
        </div>

        {(isSixDigitOtp || !initialToken) && (
          <div className="space-y-1.5">
            <label htmlFor="reset-email" className="block text-xs font-medium text-slate-300">
              Account Email {isSixDigitOtp ? '(Required for 6-digit OTP)' : '(Optional for link token)'}
            </label>
            <div className="relative">
              <Mail
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="reset-email"
                type="email"
                required={isSixDigitOtp}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@brotransport.com"
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="reset-password" className="block text-xs font-medium text-slate-300">
            New Password (min 10 characters)
          </label>
          <div className="relative">
            <Lock
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="reset-password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="reset-confirm" className="block text-xs font-medium text-slate-300">
            Confirm New Password
          </label>
          <div className="relative">
            <Lock
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="reset-confirm"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••••••"
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

        <button
          type="submit"
          disabled={loading}
          className="w-full min-h-[48px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm bg-bro-cyan hover:bg-cyan-300 text-black transition-colors disabled:opacity-50 cursor-pointer"
        >
          <span>{loading ? 'Updating Password...' : 'Set New Password & Sign In'}</span>
          <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
        </button>
      </form>

      <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
        <a href="/login" className="text-slate-300 hover:text-white font-medium">
          ← Return to Sign-In
        </a>
        <a href="/forgot-password" className="text-bro-cyan hover:text-cyan-300 font-medium">
          Request New Link
        </a>
      </div>
    </div>
  );
}
