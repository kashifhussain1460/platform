import { Global, Module } from '@nestjs/common';
import { MetricsRegistry } from './metrics.registry';

/**
 * WAVE 5 §5.3 — the metrics registry, global.
 *
 * `@Global` for the same reason as AuditModule: instrumentation is cross-cutting
 * and the registry depends on nothing, so it can never take part in a cycle.
 * Requiring ~15 modules to import it would guarantee that the one place someone
 * forgets is the place that most needed a metric.
 */
@Global()
@Module({
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class ObservabilityModule {}
