'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Mail } from 'lucide-react';
import {
  AuthButton,
  AuthCheckbox,
  AuthLink,
  Divider,
  IconInput,
  PasswordInput,
  SocialRow,
} from '@/components/auth/fields';
import { useLogin } from '../hooks';
import { loginSchema, type LoginDto } from '../schemas';

const labelClass = 'mb-1.5 block text-sm font-medium text-zinc-300';

export function LoginForm() {
  const router = useRouter();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginDto>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await login.mutateAsync(values);
      router.push(result.company.onboardedAt ? '/dashboard' : '/onboarding');
    } catch {
      // surfaced below via login.error
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div>
        <label htmlFor="email" className={labelClass}>
          Email address
        </label>
        <IconInput
          id="email"
          icon={Mail}
          type="email"
          autoComplete="email"
          placeholder="you@yopmail.com"
          {...register('email')}
        />
        {errors.email && <p className="mt-1.5 text-sm text-red-400">{errors.email.message}</p>}
      </div>

      <div>
        <label htmlFor="password" className={labelClass}>
          Password
        </label>
        <PasswordInput
          id="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          {...register('password')}
        />
        {errors.password && <p className="mt-1.5 text-sm text-red-400">{errors.password.message}</p>}
      </div>

      <div className="flex items-center justify-between">
        <AuthCheckbox label="Remember me" />
        <AuthLink href="/forgot-password">Forgot password?</AuthLink>
      </div>

      {login.isError && (
        <p className="text-sm text-red-400">{login.error?.message ?? 'Login failed'}</p>
      )}

      <AuthButton type="submit" disabled={isSubmitting || login.isPending}>
        {login.isPending ? 'Signing in…' : 'Sign In'}
      </AuthButton>

      <Divider label="or continue with" />
      <SocialRow />
    </form>
  );
}
