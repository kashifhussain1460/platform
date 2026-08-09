'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { passwordSchema } from '@vaep/types';
import { AuthButton, AuthLink, PasswordInput } from '@/components/auth/fields';
import { useResetPassword } from '@/features/auth/hooks';

const RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'One number', test: (p) => /\d/.test(p) },
];

export default function ResetPasswordPage() {
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const reset = useResetPassword();

  // Read the token from the link (?token=…) without needing a Suspense boundary.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setToken(new URLSearchParams(window.location.search).get('token') ?? '');
    }
  }, []);

  // Mirror the canonical backend policy; match is a client-only guard.
  const canSubmit =
    token.length > 0 && passwordSchema.safeParse(pwd).success && pwd === confirm && !reset.isPending;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    reset.mutate({ token, password: pwd });
  };

  if (reset.isSuccess) {
    return (
      <AuthShell heading="Password updated" subtitle="You can now sign in with your new password.">
        <div className="mt-4">
          <AuthButton type="button" onClick={() => (window.location.href = '/login')}>
            Continue to sign in
          </AuthButton>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Set a new password" subtitle="Enter and confirm your new password.">
      <form className="space-y-5" onSubmit={onSubmit} noValidate>
        {!token ? (
          <p role="alert" className="text-sm text-red-400">
            This reset link is missing its token. Request a new one from{' '}
            <AuthLink href="/forgot-password">Forgot password</AuthLink>.
          </p>
        ) : null}
        <div>
          <label htmlFor="new-pass" className="mb-1.5 block text-sm font-medium text-zinc-300">
            New password
          </label>
          <PasswordInput
            id="new-pass"
            autoComplete="new-password"
            placeholder="Enter new password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="confirm-pass" className="mb-1.5 block text-sm font-medium text-zinc-300">
            Confirm new password
          </label>
          <PasswordInput
            id="confirm-pass"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {confirm.length > 0 && confirm !== pwd ? (
            <p className="mt-1.5 text-sm text-red-400">Passwords don&apos;t match.</p>
          ) : null}
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <p className="text-xs font-medium text-zinc-400">Recommended:</p>
          <ul className="mt-3 space-y-2">
            {RULES.map((r) => {
              const ok = r.test(pwd);
              return (
                <li key={r.label} className="flex items-center gap-2.5 text-sm">
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full ${ok ? 'bg-emerald-500/90' : 'bg-white/[0.08]'}`}
                  >
                    <Check className={`h-3 w-3 ${ok ? 'text-white' : 'text-zinc-600'}`} strokeWidth={3} />
                  </span>
                  <span className={ok ? 'text-zinc-200' : 'text-zinc-500'}>{r.label}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {reset.isError ? (
          <p role="alert" className="text-sm text-red-400">
            {reset.error?.message ?? 'This reset link is invalid or has expired.'}
          </p>
        ) : null}

        <AuthButton type="submit" disabled={!canSubmit}>
          {reset.isPending ? 'Resetting…' : 'Reset password'}
        </AuthButton>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-400">
        Remember your password? <AuthLink href="/login">Sign in</AuthLink>
      </p>
    </AuthShell>
  );
}
