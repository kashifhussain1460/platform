/**
 * WAVE 5 §5.1 / WAVE 9 §Observability — real distributed traces.
 *
 * The gate recorded "Traces ❌ — no OpenTelemetry anywhere". A trace *id* did
 * propagate (see `execution-context.ts`), which is enough to correlate LOGS but
 * produces no spans and no timeline: you could find every line belonging to one
 * run, and still not see which step spent the ninety seconds.
 *
 * ## Why this file is imported first, and is not a Nest provider
 *
 * Auto-instrumentation works by patching modules as they are `require`d. A Nest
 * provider is constructed long after `http`, `pg` and `ioredis` have been loaded,
 * so by then there is nothing left to patch. `main.ts` imports this module
 * before `./app.module` for that reason, and the import must stay first.
 *
 * ## Off unless asked
 *
 * Tracing is inert without `OTEL_EXPORTER_OTLP_ENDPOINT`. That is deliberate:
 * an exporter pointed at nothing retries in the background for the life of the
 * process, and "observability made the app slower" is how observability gets
 * turned off for good. Local: `docker compose -f infra/docker-compose.yml up -d`
 * starts Jaeger, then set the endpoint to `http://localhost:4318`.
 */
import type { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

/** The configured collector, or undefined when tracing is off. */
export function tracingEndpoint(): string | undefined {
  const raw = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  return raw.length > 0 ? raw : undefined;
}

export function tracingEnabled(): boolean {
  return tracingEndpoint() !== undefined;
}

/**
 * Start the SDK. Safe to call twice; a no-op when no endpoint is configured.
 *
 * Everything is `require`d lazily so a deployment that never enables tracing
 * does not pay the load cost of the whole instrumentation set at boot.
 */
export function startTracing(): void {
  const endpoint = tracingEndpoint();
  if (!endpoint || sdk) return;

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NodeSDK: SDK } = require('@opentelemetry/sdk-node');
  const {
    getNodeAutoInstrumentations,
  } = require('@opentelemetry/auto-instrumentations-node');
  const {
    OTLPTraceExporter,
  } = require('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');

  sdk = new SDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'orlixa-api',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reading a file is not a unit of work anyone debugs, and fs spans
        // outnumber every other span by orders of magnitude — they bury the
        // trace they were meant to explain.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  }) as NodeSDK;

  sdk.start();
  /* eslint-enable @typescript-eslint/no-require-imports */

  // Flush on the way out. Without this the last spans before a deploy — the
  // ones describing whatever went wrong just before the restart — are dropped.
  const shutdown = (): void => {
    void sdk?.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/**
 * The active span's trace id, when tracing is on.
 *
 * This is the join between the two systems: `runWithContext` prefers this over
 * its own random id, so a log line and the span describing the same work carry
 * the SAME `traceId`. Without it there are two correlation ids for one request
 * and neither can find the other — which is the usual reason a team has traces
 * and still greps logs.
 */
export function activeTraceId(): string | undefined {
  if (!sdk) return undefined;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { trace } = require('@opentelemetry/api');
    const span = trace.getActiveSpan();
    /* eslint-enable @typescript-eslint/no-require-imports */
    const id: unknown = span?.spanContext()?.traceId;
    // The all-zero id means "no valid span"; treating it as real would group
    // every untraced request under one id.
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id)
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

/** Test seam: forget the SDK so a spec can assert the disabled path. */
export function resetTracingForTests(): void {
  sdk = undefined;
}
