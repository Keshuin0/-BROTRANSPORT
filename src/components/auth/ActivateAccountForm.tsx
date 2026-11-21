import React, { useState, useEffect } from 'react';
import { ShieldCheck, Lock, KeyRound, ArrowRight, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ROLE_LABELS, canAccessRoute, defaultHomeForRole, type UserRole } from '@bro/contracts';

interface ActivateAccountFormProps {
  token?: string;
  mode?: string;
  nextPath?: string;
  currentUser?: {
    name: string;
    email: string;
    role: UserRole;
    mustChangePassword?: boolean;
    title?: string | null;
  } | null;
}

interface InvitePreview {
  valid: boolean;
  email?: string;
  name?: string;
  role?: UserRole;
  roleLabel?: string;
  title?: string | null;
  expiresAt?: number;
  error?: string;
}

export default function ActivateAccountForm({
  token = '',
  mode = '',
  nextPath = '',
  currentUser = null,
}: ActivateAccountFormProps) {
  const isSetPasswordMode = mode === 'set-password' || (!token && Boolean(currentUser));
  const [inviteToken, setInviteToken] = useState(token);
  const [inviteInfo, setInviteInfo] = useState<InvitePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(Boolean(token) && !isSetPasswordMode);

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isSetPasswordMode || !inviteToken || inviteToken.trim().length < 16) {
      setLoadingPreview(false);
      return;
    }

    let cancelled = false;
    setLoadingPreview(true);
    fetch(`/api/auth/invite-info?token=${encodeURIComponent(inviteToken.trim())}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({ valid: false }))) as InvitePreview;
        if (!cancelled) {
          setInviteInfo(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInviteInfo({ valid: false, error: 'Unable to verify invite token.' });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [inviteToken, isSetPasswordMode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Password confirmation does not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (isSetPasswordMode) {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(currentPassword ? { currentPassword } : {}),
            newPassword: password,
          }),
        });
        const data = (await res.json()) as { error?: string; redirectTo?: string };
        if (!res.ok) throw new Error(data.error || 'Unable to update password.');

        setSuccessMsg('Password updated. Redirecting to your workspace...');
        const safeNext =
          nextPath &&
          nextPath.startsWith('/') &&
          !nextPath.startsWith('//') &&
          currentUser?.role &&
          canAccessRoute(currentUser.role, nextPath)
            ? nextPath
            : data.redirectTo || (currentUser ? defaultHomeForRole(currentUser.role) : '/');
        window.location.href = safeNext;
      } else {
        const res = await fetch('/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: inviteToken.trim(),
            password,
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          redirectTo?: string;
          user?: { role?: UserRole };
        };
        if (!res.ok) throw new Error(data.error || 'Account activation failed.');

        setSuccessMsg('Account activated! Redirecting to your portal...');
        window.location.href = data.redirectTo || (data.user?.role ? defaultHomeForRole(data.user.role) : '/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto surface-ceramic rounded-3xl p-6 sm:p-8 space-y-6">
      <div className="space-y-2 border-b border-white/[0.08] pb-5">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-bro-cyan/10 border border-bro-cyan/30 text-bro-cyan text-xs font-medium">
          <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{isSetPasswordMode ? 'Zero-Trust Credential Rotation' : 'Staff & Portal Onboarding'}</span>
        </div>
        <h1 className="text-2xl font-display font-bold text-white tracking-tight">
          {isSetPasswordMode ? 'Set Permanent Password' : 'Activate Your Account'}
        </h1>
        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
          {isSetPasswordMode
            ? 'Your account was provisioned with a temporary password. Set a private 10+ character password to unlock your workspace.'
            : 'Complete your zero-trust account activation to access your assigned #BRO Transport workspace.'}
        </p>
      </div>

      {isSetPasswordMode && currentUser && (
        <div className="p-4 rounded-2xl bg-[#060912] border border-bro-gold/35 space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Authenticated Identity</span>
            <span className="font-semibold text-white">{currentUser.name}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Email</span>
            <span className="font-mono text-slate-200">{currentUser.email}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Assigned Role</span>
            <span className="font-semibold text-bro-gold">{ROLE_LABELS[currentUser.role] ?? currentUser.role}</span>
          </div>
          {currentUser.title && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Title</span>
              <span className="text-slate-200">{currentUser.title}</span>
            </div>
          )}
        </div>
      )}

      {!isSetPasswordMode && loadingPreview && (
        <div className="p-4 rounded-2xl bg-[#060912] border border-white/10 text-xs text-slate-300">
          Verifying cryptographic invitation token...
        </div>
      )}

      {!isSetPasswordMode && !loadingPreview && inviteInfo?.valid && (
        <div className="p-4 rounded-2xl bg-[#060912] border border-bro-cyan/35 space-y-1.5 text-xs">
          <div className="flex items-center gap-2 text-emerald-300 font-semibold pb-1">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Verified Invitation</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Recipient</span>
            <span className="font-semibold text-white">{inviteInfo.name}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Email</span>
            <span className="font-mono text-slate-200">{inviteInfo.email}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Assigned RBAC Role</span>
            <span className="font-semibold text-bro-cyan">{inviteInfo.roleLabel}</span>
          </div>
          {inviteInfo.title && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Specialist Title</span>
              <span className="text-slate-200">{inviteInfo.title}</span>
            </div>
          )}
        </div>
      )}

      {!isSetPasswordMode && !loadingPreview && inviteToken && inviteInfo && !inviteInfo.valid && (
        <div
          role="alert"
          className="p-4 rounded-2xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-300" aria-hidden="true" />
          <div>
            <div className="font-semibold">Invalid or Expired Invite Link</div>
            <p className="mt-1 text-rose-200/90">
              {inviteInfo.error || 'Ask your Super Admin or Shipper Admin to resend your onboarding invitation.'}
            </p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {!isSetPasswordMode && !token && (
          <div className="space-y-1.5">
            <label htmlFor="activate-token" className="block text-xs font-medium text-slate-300">
              Invitation Activation Token
            </label>
            <div className="relative">
              <KeyRound
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="activate-token"
                type="text"
                required
                value={inviteToken}
                onChange={(e) => setInviteToken(e.target.value)}
                placeholder="Paste 64-character hex activation token"
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-xs font-mono text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </div>
        )}

        {isSetPasswordMode && currentUser && !currentUser.mustChangePassword && (
          <div className="space-y-1.5">
            <label htmlFor="current-password" className="block text-xs font-medium text-slate-300">
              Current Password
            </label>
            <div className="relative">
              <Lock
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="current-password"
                type="password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-400 outline-none focus:border-bro-cyan"
              />
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="activate-password" className="block text-xs font-medium text-slate-300">
            New Password (min 10 characters)
          </label>
          <div className="relative">
            <Lock
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="activate-password"
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
          <label htmlFor="activate-confirm" className="block text-xs font-medium text-slate-300">
            Confirm New Password
          </label>
          <div className="relative">
            <Lock
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="activate-confirm"
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

        {successMsg && (
          <div
            role="status"
            aria-live="polite"
            className="p-3.5 rounded-xl bg-emerald-950/70 border border-emerald-400/50 text-emerald-200 text-xs font-medium"
          >
            {successMsg}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || (!isSetPasswordMode && Boolean(inviteInfo && !inviteInfo.valid))}
          className="w-full min-h-[48px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm bg-bro-cyan hover:bg-cyan-300 text-black transition-colors disabled:opacity-50 cursor-pointer"
        >
          <span>
            {submitting
              ? 'Securing Account...'
              : isSetPasswordMode
                ? 'Save Password & Enter Workspace'
                : 'Activate Account & Sign In'}
          </span>
          <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
        </button>
      </form>

      <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
        <a href="/login" className="text-bro-cyan hover:text-cyan-300 font-medium">
          ← Return to Sign-In
        </a>
        <span>PBKDF2-SHA256 (100k iter)</span>
      </div>
    </div>
  );
}
