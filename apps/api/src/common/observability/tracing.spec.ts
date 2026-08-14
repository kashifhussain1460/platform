import {
  activeTraceId,
  resetTracingForTests,
  startTracing,
  tracingEnabled,
  tracingEndpoint,
} from './tracing';

/**
 * The property worth testing here is not "spans are produced" — that needs a
 * collector, and a test that asserts a vendor SDK works is testing the vendor.
 *
 * It is that tracing is genuinely INERT when unconfigured. An exporter pointed
 * at nothing retries in the background for the life of the process, and the
 * first thing anyone does about that is turn observability off for good.
 */
describe('tracing', () => {
  const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
    resetTracingForTests();
  });

  it('is off when no endpoint is configured', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    expect(tracingEndpoint()).toBeUndefined();
    expect(tracingEnabled()).toBe(false);
    // Must not throw, and must not start an SDK.
    expect(() => startTracing()).not.toThrow();
    expect(activeTraceId()).toBeUndefined();
  });

  it('treats a blank endpoint as off, not as an empty URL', () => {
    // `OTEL_EXPORTER_OTLP_ENDPOINT=` in a .env file reads as '' rather than
    // absent. Taking that literally would build an exporter pointed at "/v1/traces".
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '   ';

    expect(tracingEndpoint()).toBeUndefined();
    expect(tracingEnabled()).toBe(false);
  });

  it('reports the configured endpoint', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    expect(tracingEndpoint()).toBe('http://localhost:4318');
    expect(tracingEnabled()).toBe(true);
  });

  it('returns no trace id while the SDK has not been started', () => {
    // The bridge in execution-context.ts calls this on EVERY context creation,
    // including in tests and in the e2e suite. It must be cheap and silent when
    // tracing is off, never throw, and never invent an id — an all-zero or
    // fabricated id would group unrelated requests under one trace.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    expect(activeTraceId()).toBeUndefined();
  });
});
