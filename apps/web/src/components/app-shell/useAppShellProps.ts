'use client';

import { useRouter } from 'next/navigation';
import { useApprovals } from '@/features/approvals/hooks';
import { useCurrentUser, useLogout } from '@/features/auth/hooks';
import { useCurrentCompany } from '@/features/tenant/hooks';

/**
 * Shared session/approvals/logout wiring for every page that renders
 * `<AppShell>` — keeps that boilerplate out of each page component.
 */
export function useAppShellProps() {
  const router = useRouter();
  const { data: me } = useCurrentUser();
  const { data: company } = useCurrentCompany();
  const { data: pendingApprovals } = useApprovals('PENDING');
  const logout = useLogout();

  const user = me?.user;
  const activeCompany = company ?? me?.company;
  // `canManageOrg` is gone: which admin areas a user is offered is decided by
  // the resolver (`AREA_MIN_ROLE` ∧ the real authorization policy), so the
  // shell no longer keeps its own copy of that rule.

  const onLogout = async () => {
    await logout.mutateAsync();
    router.replace('/login');
  };

  return {
    companyName: activeCompany?.name,
    user,
    pendingApprovals: pendingApprovals?.length ?? 0,
    onLogout,
    loggingOut: logout.isPending,
  };
}
