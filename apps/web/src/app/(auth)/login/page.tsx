import { LoginForm } from '@/features/auth/components/LoginForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthLink } from '@/components/auth/fields';

export default function LoginPage() {
  return (
    <AuthShell heading="Welcome back" subtitle="Sign in to continue to your account">
      <LoginForm />
      <p className="mt-6 text-center text-sm text-zinc-400">
        Don&apos;t have an account? <AuthLink href="/register">Sign up</AuthLink>
      </p>
    </AuthShell>
  );
}
