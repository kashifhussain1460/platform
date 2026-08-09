'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthButton } from '@/components/auth/fields';
import { EnvelopeCheck } from '@/components/auth/illustrations';
import { useSessionStore } from '@/stores/session.store';
import { useResendVerification, useVerifyEmail } from '@/features/auth/hooks';

/**
 * Verify email via a 6-digit OTP. While the mailer is disabled the server issues
 * the fixed dev code 123456, so a tester can complete this without an inbox.
 * On success the identity refreshes (emailVerified=true) and we hand off to the
 * SAME destination the (auth) guard uses: onboarded companies go to /dashboard,
 * everyone else to /onboarding. Hardcoding /onboarding stranded already-onboarded
 * users (e.g. accounts predating email verification) back in the wizard.
 */
export default function VerifyEmailPage() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const company = useSessionStore((s) => s.company);
  const [code, setCode] = useState('');
  const verify = useVerifyEmail();
  const resend = useResendVerification();

  const destination = company?.onboardedAt ? '/dashboard' : '/onboarding';

  // Already verified (or opened directly) → don't strand the user here.
  useEffect(() => {
    if (user?.emailVerified) router.replace(destination);
  }, [user?.emailVerified, destination, router]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || verify.isPending) return;
    await verify.mutateAsync(code);
    router.push(destination);
  };

  return (
    <AuthShell topSlot={<div className="mt-8 flex justify-center"><EnvelopeCheck /></div>}>
      <div className="text-center">
        <h1 className="text-[26px] font-bold leading-tight tracking-tight text-white">
          Verify your email
        </h1>
        <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-zinc-400">
          We&apos;ve sent a 6-digit code to{' '}
          <span className="font-semibold text-zinc-200">{user?.email ?? 'your email'}</span>.
          Enter it below to continue.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-label="6-digit verification code"
            aria-invalid={verify.isError || undefined}
            className="field-modern w-full text-center text-lg tracking-[0.5em]"
            placeholder="••••••"
          />
          {verify.isError ? (
            <p role="alert" className="text-sm text-red-400">
              {verify.error?.message ?? 'That code is not valid.'}
            </p>
          ) : null}
          <AuthButton type="submit" disabled={code.length !== 6 || verify.isPending}>
            {verify.isPending ? 'Verifying…' : 'Verify email'}
          </AuthButton>
        </form>

        <p className="mt-8 text-sm text-zinc-400">
          Didn&apos;t receive it?{' '}
          <button
            type="button"
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
            className="font-semibold text-violet-300 hover:text-violet-200 disabled:opacity-50"
          >
            {resend.isPending ? 'Sending…' : 'Resend'}
          </button>
          {resend.isError ? (
            <span role="alert" className="ml-2 text-red-400">
              {resend.error?.message ?? 'Please wait a moment.'}
            </span>
          ) : null}
          {resend.isSuccess ? <span className="ml-2 text-emerald-400">Sent.</span> : null}
        </p>
      </div>
    </AuthShell>
  );
}
