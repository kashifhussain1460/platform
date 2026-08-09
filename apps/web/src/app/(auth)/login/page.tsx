import { LoginForm } from '@/features/auth/components/LoginForm';
import { AuthSplitShell } from '@/components/auth/AuthSplitShell';
import { AuthLink } from '@/components/auth/fields';

export default function LoginPage() {
  return (
    <AuthSplitShell
      heading="Welcome back"
      subtitle="Sign in to continue to your account"
      bgVideo="/login-loop.mp4"
    >
      <LoginForm />
      <p className="mt-6 text-center text-sm text-zinc-400">
        Don&apos;t have an account? <AuthLink href="/register">Sign up</AuthLink>
      </p>
    </AuthSplitShell>
  );
}
