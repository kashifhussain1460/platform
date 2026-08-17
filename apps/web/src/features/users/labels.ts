import type { Role, UserStatus } from '@vaep/types';

/** Human label for a membership role. */
export const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};

/** Tailwind badge classes per role (dark theme, soft-fill pill). */
export const ROLE_BADGE: Record<Role, string> = {
  OWNER: 'bg-violet/15 text-violet',
  ADMIN: 'bg-blue-500/15 text-blue-800',
  MEMBER: 'bg-app-raised text-app-ink-2',
};

/** Human label for an account status. */
export const STATUS_LABEL: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  DISABLED: 'Disabled',
};

/** Tailwind badge classes per status (dark theme, outlined pill). */
export const STATUS_BADGE: Record<UserStatus, string> = {
  ACTIVE: 'border border-green-500/40 text-green-700',
  DISABLED: 'border border-app-border text-app-ink-3',
};
