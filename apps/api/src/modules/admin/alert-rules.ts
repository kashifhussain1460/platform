import { METRIC } from '../../common/observability/metrics.registry';

/** An alert rule: a threshold over a metric, with what to do about it. */
export interface AlertRule {
  name: string;
  metric: string;
  /** Fires when the metric is at or above this. */
  threshold: number;
  severity: 'warning' | 'critical';
  summary: string;
}

/**
 * WAVE 5 §5.4 — the alert rules the plan lists, as DATA.
 *
 * Be clear about what this is and is not: it is not a paging system, and it does
 * not replace Prometheus + Alertmanager. It is the rule set expressed once, in
 * the codebase, so that (a) `/admin/alerts` gives an operator a straight answer
 * during an incident without a monitoring stack being wired up first, and (b)
 * the thresholds live next to the code that emits the metrics instead of drifting
 * apart in someone's dashboard.
 */
export const ALERT_RULES: AlertRule[] = [
  {
    name: 'queue_backlog',
    metric: METRIC.queueDepth,
    threshold: 500,
    severity: 'warning',
    summary: 'Queue depth is high — workers may be down or too slow',
  },
  {
    name: 'outbox_backlog',
    metric: METRIC.outboxBacklog,
    threshold: 1_000,
    severity: 'warning',
    summary: 'Run-event outbox is not draining — realtime UI will lag',
  },
  {
    name: 'workflow_failure_spike',
    metric: METRIC.workflowFailureTotal,
    threshold: 50,
    severity: 'critical',
    summary: 'Elevated workflow failures since this process started',
  },
  {
    name: 'skill_failure_spike',
    metric: METRIC.skillFailureTotal,
    threshold: 50,
    severity: 'warning',
    summary: 'Elevated external skill/provider failures',
  },
  {
    name: 'oauth_refresh_failures',
    metric: METRIC.oauthRefreshFailureTotal,
    threshold: 10,
    severity: 'warning',
    summary: 'OAuth token refreshes are failing — connectors will disconnect',
  },
  {
    // Credit system Phase 10, Task 10.3 (§25.3) — the internal-consistency
    // leg is a structural invariant, not a rounding-tolerance comparison:
    // ANY orphaned DEBIT (no traceable reservation) is a real bug, so the
    // threshold is 1, not a tuned tolerance figure.
    name: 'credit_reconciliation_discrepancy',
    metric: METRIC.creditReconciliationDiscrepancyTotal,
    threshold: 1,
    severity: 'critical',
    summary: 'Credit ledger reconciliation found an untraceable entry — see ReconciliationDiscrepancy',
  },
];
