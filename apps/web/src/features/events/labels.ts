import type { CanonicalEventType } from '@vaep/types';

/** Friendly labels for the canonical event vocabulary (UI display). */
export const CANONICAL_EVENT_LABELS: Record<CanonicalEventType, string> = {
  NEW_EMAIL: 'New email',
  EMAIL_REPLIED: 'Email replied',
  NEW_LEAD: 'New lead',
  LEAD_STAGE_CHANGED: 'Lead stage changed',
  NEW_PAYMENT: 'New payment',
  PAYMENT_FAILED: 'Payment failed',
  NEW_JIRA_ISSUE: 'New Jira issue',
  JIRA_ISSUE_UPDATED: 'Jira issue updated',
  NEW_GITHUB_PR: 'New GitHub PR',
  NEW_GITHUB_ISSUE: 'New GitHub issue',
  NEW_TICKET: 'New support ticket',
  TICKET_REPLIED: 'Customer replied on a ticket',
  NEW_PROJECT_ISSUE: 'New project issue',
  PROJECT_ISSUE_UPDATED: 'Project issue updated',
  // Provider-neutral (§16/§17): a support conversation being handed over and a
  // project issue being reassigned are the same thing to an automation, so the
  // label must not name either product.
  ASSIGNMENT_CHANGED: 'Assignment changed',
  STATUS_CHANGED: 'Status changed',
  NEW_DOCUMENT: 'New document',
  NEW_CANDIDATE: 'New candidate',
  UNKNOWN: 'Unknown event',
};

/** "NEW_GITHUB_PR" → "New GitHub PR" (falls back to the raw value). */
export function formatEventType(type: CanonicalEventType): string {
  return CANONICAL_EVENT_LABELS[type] ?? type;
}
