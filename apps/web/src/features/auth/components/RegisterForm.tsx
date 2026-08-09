'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { passwordSchema } from '@vaep/types';
import { Mail, User } from 'lucide-react';
import { AuthButton, IconInput, PasswordInput } from '@/components/auth/fields';
import { useRegister } from '../hooks';
import type { RegisterDto } from '../schemas';

const labelClass = 'mb-1.5 block text-sm font-medium text-zinc-300';

/**
 * UI-level schema for the mockup's Sign Up (name + email + password + confirm
 * + terms). The backend RegisterDto still requires a company name, so on submit
 * we derive a workspace name from the person's name; the real company profile
 * is collected in the onboarding wizard. Backend contract is unchanged.
 */
const signupSchema = z
  .object({
    name: z.string().min(1, 'Please enter your name'),
    email: z.string().min(1, 'Email is required').email('Enter a valid email'),
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
    agree: z.literal(true, { errorMap: () => ({ message: 'Please accept the terms to continue' }) }),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

type SignupForm = z.infer<typeof signupSchema>;

export function RegisterForm() {
  const router = useRouter();
  const registerMutation = useRegister();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupForm>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '', agree: false as unknown as true },
  });

  const onSubmit = handleSubmit(async (values) => {
    const payload: RegisterDto = {
      companyName: `${values.name.trim()}'s Workspace`,
      name: values.name.trim(),
      email: values.email.trim(),
      password: values.password,
    };
    try {
      await registerMutation.mutateAsync(payload);
      // New accounts are unverified — confirm the emailed OTP before onboarding.
      router.push('/verify-email');
    } catch {
      // surfaced below via registerMutation.error
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div>
        <label htmlFor="name" className={labelClass}>
          Full name
        </label>
        <IconInput id="name" icon={User} autoComplete="name" placeholder="John Doe" {...register('name')} />
        {errors.name && <p className="mt-1.5 text-sm text-red-400">{errors.name.message}</p>}
      </div>

      <div>
        <label htmlFor="email" className={labelClass}>
          Work email
        </label>
        <IconInput
          id="email"
          icon={Mail}
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
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
          autoComplete="new-password"
          placeholder="Create a strong password"
          {...register('password')}
        />
        {errors.password && <p className="mt-1.5 text-sm text-red-400">{errors.password.message}</p>}
      </div>

      <div>
        <label htmlFor="confirmPassword" className={labelClass}>
          Confirm password
        </label>
        <PasswordInput
          id="confirmPassword"
          autoComplete="new-password"
          placeholder="Confirm your password"
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p className="mt-1.5 text-sm text-red-400">{errors.confirmPassword.message}</p>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-400">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-white/20 bg-white/5 accent-[#6a30ec]"
          {...register('agree')}
        />
        <span>
          I agree to the <span className="text-[#8b6ef2]">Terms of Service</span> and{' '}
          <span className="text-[#8b6ef2]">Privacy Policy</span>
        </span>
      </label>
      {errors.agree && <p className="text-sm text-red-400">{errors.agree.message}</p>}

      {registerMutation.isError && (
        <p className="text-sm text-red-400">{registerMutation.error?.message ?? 'Registration failed'}</p>
      )}

      <AuthButton type="submit" disabled={isSubmitting || registerMutation.isPending}>
        {registerMutation.isPending ? 'Creating…' : 'Create Account'}
      </AuthButton>
    </form>
  );
}
