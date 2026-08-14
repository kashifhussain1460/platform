import 'reflect-metadata';
// MUST stay above every other application import. Auto-instrumentation patches
// modules as they are required, so anything loaded before the SDK starts is
// never traced — and the symptom is silent: traces appear, just with the
// interesting spans missing.
import { startTracing } from './common/observability/tracing';

startTracing();

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import {
  StructuredLogger,
  structuredLoggingEnabled,
} from './common/observability/structured-logger';

async function bootstrap(): Promise<void> {
  // rawBody: true buffers the raw request body (exposed as req.rawBody) so the
  // Stripe webhook can verify its signature. JSON parsing is unaffected — normal
  // routes still receive a parsed req.body and the global ValidationPipe applies.
  // WAVE 5 §5.2 — `LOG_FORMAT=json` emits one JSON object per line, carrying the
  // ambient execution context, so logs are SEARCHABLE by workflowRunId/traceId
  // instead of grep-able as prose. Unset keeps the readable console output, so
  // this changes nothing locally.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new StructuredLogger(structuredLoggingEnabled()),
  });
  const config = app.get(ConfigService);

  configureApp(app);

  // Without this, Nest never calls onModuleDestroy — so PrismaService's
  // $disconnect, DlqService's queue teardown and ResilienceModule's Redis quit
  // were all dead code, and a rolling deploy abandoned in-flight BullMQ jobs
  // instead of draining them (relying only on stalled-job detection, which the
  // workflow-run watchdog's own comment says isn't fully reliable).
  // Long-running process only — the Vercel serverless entry has no lifecycle to
  // hook, which is why this lives here and not in the shared configureApp().
  app.enableShutdownHooks();

  const port = Number(config.get<string>('PORT') ?? '4000');
  await app.listen(port);
  console.log(`[v-aep/api] listening on http://localhost:${port}`);
}

void bootstrap();
