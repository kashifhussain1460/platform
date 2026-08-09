'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthButton, AuthLink, IconInput } from '@/components/auth/fields';
import { PaperPlane } from '@/components/auth/illustrations';
import { useForgotPassword, useVerifyResetOtp } from '@/features/auth/hooks';

/**
 * OTP-based password recovery.
 *   1. Enter email → the server issues a 6-digit reset code (fixed 123456 while
 *      mail is disabled). Anti-enumeration: it always responds the same, so we
 *      always advance to the code step.
 *   2. Enter the code → the server hands back a single-use token and we go to
 *      /reset-password to set the new password. A wrong/unknown email fails
 *      generically at this step, never revealing whether the account exists.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const forgot = useForgotPassword();
  const verify = useVerifyResetOtp();

  const onSendCode = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || forgot.isPending) return;
    forgot.mutate(value, { onSuccess: () => setStep('code') });
  };

  const onVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || verify.isPending) return;
    verify.mutate(
      { email: email.trim(), code },
      { onSuccess: ({ token }) => router.push(`/reset-password?token=${token}`) },
    );
  };

  if (step === 'code') {
    return (
      <AuthShell
        heading="Enter your reset code"
        subtitle={`We've sent a 6-digit code to ${email.trim()}. Enter it to continue.`}
      >
        <form className="space-y-5" onSubmit={onVerify} noValidate>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-label="6-digit reset code"
            aria-invalid={verify.isError || undefined}
            className="field-modern w-full text-center text-lg tracking-[0.5em]"
            placeholder="••••••"
          />
          {verify.isError ? (
            <p role="alert" className="text-sm text-red-400">
              {verify.error?.message ?? 'That code is invalid or has expired.'}
            </p>
          ) : null}
          <AuthButton type="submit" disabled={code.length !== 6 || verify.isPending}>
            {verify.isPending ? 'Verifying…' : 'Continue'}
          </AuthButton>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-400">
          Didn&apos;t get it?{' '}
          <button
            type="button"
            onClick={() => forgot.mutate(email.trim())}
            disabled={forgot.isPending}
            className="font-semibold text-violet-300 hover:text-violet-200 disabled:opacity-50"
          >
            {forgot.isPending ? 'Sending…' : 'Resend code'}
          </button>
          {forgot.isSuccess ? <span className="ml-2 text-emerald-400">Sent.</span> : null}
        </p>
        <p className="mt-2 text-center text-sm text-zinc-400">
          <button
            type="button"
            onClick={() => setStep('email')}
            className="text-zinc-400 underline hover:text-zinc-200"
          >
            Use a different email
          </button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      heading="Forgot your password?"
      subtitle="No worries — enter your email and we'll send you a code to reset it."
    >
      <form className="space-y-5" onSubmit={onSendCode} noValidate>
        <div>
          <label htmlFor="fp-email" className="mb-1.5 block text-sm font-medium text-zinc-300">
            Work email
          </label>
          <IconInput
            id="fp-email"
            icon={Mail}
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {forgot.isError ? (
          <p role="alert" className="text-sm text-red-400">
            {forgot.error?.message ?? 'Something went wrong. Try again.'}
          </p>
        ) : null}
        <AuthButton type="submit" disabled={!email.trim() || forgot.isPending}>
          {forgot.isPending ? 'Sending…' : 'Send reset code'}
        </AuthButton>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-400">
        Remember your password? <AuthLink href="/login">Sign in</AuthLink>
      </p>

      <div aria-hidden className="pointer-events-none mt-8">
        <PaperPlane />
      </div>
    </AuthShell>
  );
}
