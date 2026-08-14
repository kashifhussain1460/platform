import {
  currentContext,
  enrichContext,
  runWithContext,
  traceIdFromTraceparent,
} from './execution-context';
import { MetricsRegistry } from './metrics.registry';

describe('execution context (WAVE 5 §5.1)', () => {
  it('is undefined outside any tracked scope', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('survives across awaits — the whole reason for AsyncLocalStorage', async () => {
    // A threaded parameter survives exactly as long as someone remembers to
    // pass it; the one place it gets dropped is the place you needed it.
    await runWithContext({ workflowRunId: 'run-1' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      expect(currentContext()?.workflowRunId).toBe('run-1');
    });
  });

  it('generates a requestId and traceId when none is supplied', () => {
    runWithContext({}, () => {
      expect(currentContext()?.requestId).toBeTruthy();
      expect(currentContext()?.traceId).toBeTruthy();
    });
  });

  it('nested scopes inherit the parent and override only what they set', () => {
    runWithContext({ requestId: 'r1', companyId: 'co1' }, () => {
      runWithContext({ workflowRunId: 'run-1' }, () => {
        const ctx = currentContext();
        expect(ctx?.requestId).toBe('r1');
        expect(ctx?.companyId).toBe('co1');
        expect(ctx?.workflowRunId).toBe('run-1');
      });
      // The child's fields do not leak back out.
      expect(currentContext()?.workflowRunId).toBeUndefined();
    });
  });

  it('enrichContext adds fields learned partway through', () => {
    runWithContext({ requestId: 'r1' }, () => {
      enrichContext({ workflowRunId: 'run-9' });
      expect(currentContext()?.workflowRunId).toBe('run-9');
    });
  });

  it('enrichContext is a harmless no-op outside a scope', () => {
    expect(() => enrichContext({ companyId: 'co1' })).not.toThrow();
  });

  describe('traceparent', () => {
    it('accepts a valid W3C header so an upstream trace joins up', () => {
      expect(
        traceIdFromTraceparent(
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        ),
      ).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('rejects malformed and all-zero ids', () => {
      // A bad value is worse than none: it silently groups unrelated work.
      expect(traceIdFromTraceparent(undefined)).toBeUndefined();
      expect(traceIdFromTraceparent('garbage')).toBeUndefined();
      expect(
        traceIdFromTraceparent('00-00000000000000000000000000000000-a-01'),
      ).toBeUndefined();
      expect(traceIdFromTraceparent('00-XYZ-a-01')).toBeUndefined();
    });
  });
});

describe('metrics registry (WAVE 5 §5.3)', () => {
  let metrics: MetricsRegistry;
  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  it('counts, with labels kept separate', async () => {
    metrics.counter('workflow_failure_total', 'help', { failure_class: 'TIMEOUT' });
    metrics.counter('workflow_failure_total', 'help', { failure_class: 'TIMEOUT' });
    metrics.counter('workflow_failure_total', 'help', { failure_class: 'INTERNAL' });

    expect(metrics.total('workflow_failure_total')).toBe(3);
    expect(
      metrics.total('workflow_failure_total', { failure_class: 'TIMEOUT' }),
    ).toBe(2);
  });

  it('renders Prometheus text exposition', async () => {
    metrics.counter('workflow_runs_total', 'Workflow runs started');
    const text = await metrics.render();
    expect(text).toContain('# HELP workflow_runs_total Workflow runs started');
    expect(text).toContain('# TYPE workflow_runs_total counter');
    expect(text).toContain('workflow_runs_total 1');
  });

  it('renders histogram buckets cumulatively with a +Inf bucket', async () => {
    metrics.observe('step_duration_ms', 'help', 30);
    metrics.observe('step_duration_ms', 'help', 3_000);
    const text = await metrics.render();

    expect(text).toContain('# TYPE step_duration_ms histogram');
    // 30ms falls in the 100ms bucket but not the 25ms one.
    expect(text).toContain('step_duration_ms_bucket{le="25"} 0');
    expect(text).toContain('step_duration_ms_bucket{le="100"} 1');
    expect(text).toContain('step_duration_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('step_duration_ms_sum 3030');
    expect(text).toContain('step_duration_ms_count 2');
  });

  it('escapes label values so a stray quote cannot corrupt the exposition', async () => {
    metrics.counter('skill_failure_total', 'help', { error: 'he said "no"' });
    const text = await metrics.render();
    expect(text).toContain('error="he said \\"no\\""');
  });

  it('computes scrape-time gauges through a collector', async () => {
    let depth = 7;
    metrics.registerCollector('queue_depth', 'help', () => depth);
    expect(await metrics.render()).toContain('queue_depth 7');
    depth = 2;
    expect(await metrics.render()).toContain('queue_depth 2');
  });

  it('a failing collector does not take the whole scrape down', async () => {
    // A metrics endpoint that 500s during an incident is exactly when you need
    // it most.
    metrics.registerCollector('broken', 'help', () => {
      throw new Error('redis unreachable');
    });
    metrics.counter('workflow_runs_total', 'help');
    const text = await metrics.render();
    expect(text).toContain('workflow_runs_total 1');
  });
});
