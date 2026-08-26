import { Injectable } from '@nestjs/common';

/**
 * WAVE 5 §5.3 — an in-process metrics registry with Prometheus text exposition.
 *
 * Hand-rolled rather than pulling in `prom-client`, for one reason that matters
 * more than the ~200 lines it saves: this process ALSO runs on Vercel as a
 * short-lived serverless function, where an in-process registry is nearly
 * worthless (each invocation starts empty) and a library that spawns default
 * collectors and timers is actively unhelpful. Keeping it small and dependency
 * free means the same code is harmless in both deployments, and swapping in a
 * real client later is one file.
 *
 * **Be honest about what this is:** counters and gauges live in memory and reset
 * on restart, and a multi-instance deployment exposes per-instance values that
 * a scraper must aggregate. That is the normal Prometheus model for counters,
 * but it means these numbers answer "what is this worker doing" — not "what has
 * the platform done in total". Anything needing the latter reads Postgres.
 */

type Labels = Record<string, string | number | undefined>;

interface Series {
  labels: Labels;
  value: number;
  /** Histograms only. */
  buckets?: Map<number, number>;
  sum?: number;
  count?: number;
}

interface Metric {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  series: Map<string, Series>;
  bucketBounds?: number[];
}

/** Latency buckets in ms. Wide, because a workflow step can take 30 seconds. */
export const DURATION_BUCKETS_MS = [
  5, 25, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
];

@Injectable()
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  /** Gauges whose value is computed at scrape time (queue depth, backlog). */
  private readonly collectors = new Map<string, () => Promise<number> | number>();

  counter(name: string, help: string, labels: Labels = {}, by = 1): void {
    const metric = this.ensure(name, help, 'counter');
    const series = this.series(metric, labels);
    series.value += by;
  }

  gauge(name: string, help: string, value: number, labels: Labels = {}): void {
    const metric = this.ensure(name, help, 'gauge');
    this.series(metric, labels).value = value;
  }

  observe(name: string, help: string, ms: number, labels: Labels = {}): void {
    const metric = this.ensure(name, help, 'histogram');
    metric.bucketBounds ??= DURATION_BUCKETS_MS;
    const series = this.series(metric, labels);
    series.buckets ??= new Map(metric.bucketBounds.map((b) => [b, 0]));
    series.sum = (series.sum ?? 0) + ms;
    series.count = (series.count ?? 0) + 1;
    for (const bound of metric.bucketBounds) {
      if (ms <= bound) {
        series.buckets.set(bound, (series.buckets.get(bound) ?? 0) + 1);
      }
    }
  }

  /**
   * Register a gauge computed AT SCRAPE TIME.
   *
   * Queue depth and outbox backlog are the reason this exists: pushing them on
   * every change would mean instrumenting every producer and consumer and would
   * still drift, whereas asking Redis or Postgres once per scrape is both
   * cheaper and always right.
   */
  registerCollector(
    name: string,
    help: string,
    collect: () => Promise<number> | number,
  ): void {
    this.ensure(name, help, 'gauge');
    this.collectors.set(name, collect);
  }

  /** Snapshot every metric in Prometheus text exposition format. */
  async render(): Promise<string> {
    for (const [name, collect] of this.collectors) {
      try {
        this.gauge(name, this.metrics.get(name)?.help ?? name, await collect());
      } catch {
        // A collector that cannot reach its backend must not take the whole
        // scrape down — a metrics endpoint that 500s during an incident is
        // exactly when you need it most.
      }
    }

    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const series of metric.series.values()) {
        const labels = renderLabels(series.labels);
        if (metric.type === 'histogram') {
          let cumulative = 0;
          for (const bound of metric.bucketBounds ?? []) {
            cumulative = series.buckets?.get(bound) ?? 0;
            lines.push(
              `${metric.name}_bucket${renderLabels({ ...series.labels, le: bound })} ${cumulative}`,
            );
          }
          lines.push(
            `${metric.name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count ?? 0}`,
          );
          lines.push(`${metric.name}_sum${labels} ${series.sum ?? 0}`);
          lines.push(`${metric.name}_count${labels} ${series.count ?? 0}`);
        } else {
          lines.push(`${metric.name}${labels} ${series.value}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** Plain snapshot, for the alert evaluator and for tests. */
  snapshot(): Record<string, { labels: Labels; value: number }[]> {
    const out: Record<string, { labels: Labels; value: number }[]> = {};
    for (const metric of this.metrics.values()) {
      out[metric.name] = [...metric.series.values()].map((s) => ({
        labels: s.labels,
        value: metric.type === 'histogram' ? (s.count ?? 0) : s.value,
      }));
    }
    return out;
  }

  /** Sum one metric across all label combinations. */
  total(name: string, match: Labels = {}): number {
    const metric = this.metrics.get(name);
    if (!metric) return 0;
    let sum = 0;
    for (const series of metric.series.values()) {
      const matches = Object.entries(match).every(
        ([k, v]) => v === undefined || series.labels[k] === v,
      );
      if (matches) {
        sum += metric.type === 'histogram' ? (series.count ?? 0) : series.value;
      }
    }
    return sum;
  }

  reset(): void {
    this.metrics.clear();
    this.collectors.clear();
  }

  private ensure(name: string, help: string, type: Metric['type']): Metric {
    let metric = this.metrics.get(name);
    if (!metric) {
      metric = { name, help, type, series: new Map() };
      this.metrics.set(name, metric);
    }
    return metric;
  }

  private series(metric: Metric, labels: Labels): Series {
    const key = seriesKey(labels);
    let series = metric.series.get(key);
    if (!series) {
      series = { labels: stripUndefined(labels), value: 0 };
      metric.series.set(key, series);
    }
    return series;
  }
}

function stripUndefined(labels: Labels): Labels {
  return Object.fromEntries(
    Object.entries(labels).filter(([, v]) => v !== undefined),
  );
}

function seriesKey(labels: Labels): string {
  return Object.entries(stripUndefined(labels))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(stripUndefined(labels));
  if (entries.length === 0) return '';
  const body = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
    .join(',');
  return `{${body}}`;
}

/** Prometheus label values escape backslash, quote and newline. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** WAVE 5 §5.3 — the metric names the plan lists. Centralised to stop drift. */
export const METRIC = {
  workflowRunsTotal: 'workflow_runs_total',
  workflowSuccessTotal: 'workflow_success_total',
  workflowFailureTotal: 'workflow_failure_total',
  workflowRetryTotal: 'workflow_retry_total',
  workflowDurationMs: 'workflow_duration_ms',
  stepDurationMs: 'step_duration_ms',
  queueDepth: 'queue_depth',
  queueLag: 'queue_lag',
  approvalWaitDuration: 'approval_wait_duration',
  skillFailureTotal: 'skill_failure_total',
  providerLatencyMs: 'provider_latency_ms',
  oauthRefreshFailureTotal: 'oauth_refresh_failure_total',
  llmTokensTotal: 'llm_tokens_total',
  llmCostTotal: 'llm_cost_total',
  outboxBacklog: 'outbox_backlog',
  auditRelayLag: 'audit_relay_lag',
  // Credit system Phase 3, Task 3.7 (§33).
  creditsReservedTotal: 'credits_reserved_total',
  creditsSettledTotal: 'credits_settled_total',
  creditsRefundedTotal: 'credits_refunded_total',
  creditReservationLeakDetectedTotal: 'credit_reservation_leak_detected_total',
  // Credit system Phase 10, Task 10.3 (§25.3).
  creditReconciliationDiscrepancyTotal: 'credit_reconciliation_discrepancy_total',
} as const;
