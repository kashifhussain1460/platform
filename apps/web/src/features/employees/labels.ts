import type {
  ApprovalRuleFlagKey,
  EmployeePermissionKey,
  EmployeeRole,
  EmployeeStatus,
} from '@vaep/types';

const ACRONYMS = new Set(['HR']);

/** SUPPORT → "Support", PROJECT_MANAGER → "Project Manager", HR → "HR". */
export function formatRole(role: EmployeeRole): string {
  return role
    .split('_')
    .map((w) => (ACRONYMS.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Tailwind classes for the status badge, keyed by status (dark theme). */
export const STATUS_STYLES: Record<EmployeeStatus, string> = {
  ACTIVE: 'bg-green-500/15 text-green-800',
  PAUSED: 'bg-amber-500/15 text-amber-800',
  DISABLED: 'bg-app-raised text-app-ink-2',
};

/**
 * Permission flags surfaced as checkboxes in the employee Settings panel.
 *
 * Every one of these is now ENFORCED at execution time (api
 * `skills/employee-permission-policy.ts`, applied in `SkillsService.runTool`).
 * The `hint` names what unticking it actually stops, because "Contact
 * customers" on its own does not tell an admin which tools go away.
 *
 * Do not add a checkbox here without a matching entry in
 * `EMPLOYEE_PERMISSION_CAPABILITIES` on the API side. A control that writes
 * JSON nothing reads is worse than no control — it is a safety promise the
 * product does not keep.
 */
export const PERMISSION_OPTIONS: readonly {
  key: EmployeePermissionKey;
  label: string;
  hint: string;
}[] = [
  { key: 'sendEmail', label: 'Send email', hint: 'Gmail and SMTP email sending' },
  {
    key: 'contactCustomers',
    label: 'Contact customers',
    hint: 'Email, Slack messages and support replies',
  },
  {
    key: 'makePayments',
    label: 'Make payments',
    hint: 'Stripe payment links (reading balances stays allowed)',
  },
  {
    key: 'accessKnowledge',
    label: 'Access knowledge base',
    hint: 'Retrieving your documents in chat and in workflows',
  },
];

/**
 * Approval-rule flags surfaced as checkboxes in the employee Settings panel.
 *
 * `approveOverBudget` and `approveRefunds` were REMOVED in the Phase 1 safety
 * fix. Neither could be enforced without inventing product behaviour:
 * `budgetLimit` is a hard block today rather than an approval trigger, and no
 * refund tool exists anywhere in the skill catalog. They were checkboxes that
 * wrote JSON nothing read.
 */
export const APPROVAL_RULE_OPTIONS: readonly {
  key: ApprovalRuleFlagKey;
  label: string;
  hint: string;
}[] = [
  {
    key: 'approveExternalMessages',
    label: 'Require approval for external messages',
    hint: 'Anything that sends to a person or changes an outside system waits for a human',
  },
];
