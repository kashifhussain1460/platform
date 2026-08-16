/** POC ONLY — NOT PRODUCTION. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { record } from './orlixa/recorder';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  // The Postgres World needs a long-lived worker polling the database. Without
  // this call nothing ever executes — which is the same class of gap as
  // Orlixa's own G40 (`WORKFLOW_EXECUTION_MODE=inline`).
  const { getWorld } = await import('workflow/runtime');
  const world = await getWorld();
  await world.start?.();

  const port = Number(process.env.PORT ?? 4300);
  await app.listen(port);
  record('server.started', {
    pid: process.pid,
    port,
    world: process.env.WORKFLOW_TARGET_WORLD ?? 'local',
  });
  // eslint-disable-next-line no-console
  console.log(`[poc] listening on ${port} pid=${process.pid} world=${process.env.WORKFLOW_TARGET_WORLD}`);
}

void bootstrap();
