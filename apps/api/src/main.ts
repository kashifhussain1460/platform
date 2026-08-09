import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  // rawBody: true buffers the raw request body (exposed as req.rawBody) so the
  // Stripe webhook can verify its signature. JSON parsing is unaffected — normal
  // routes still receive a parsed req.body and the global ValidationPipe applies.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
