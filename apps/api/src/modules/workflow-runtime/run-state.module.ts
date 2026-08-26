import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
import { RunStateWriter } from './run-state-writer.service';

/**
 * The run/step state writer as a LEAF module.
 *
 * `WorkflowRuntimeModule` imports `WorkflowsModule`, so `WorkflowsModule` cannot
 * import the runtime back to reach `RunStateWriter` — the same cycle WAVE 1 hit
 * with the engine-mode flag and WAVE 3 hit with the canonical ingest.
 *
 * `RunStateWriter` depends only on globals (Prisma, MetricsRegistry) plus
 * `CreditsModule` (Phase 3, Task 3.6 — the terminal-transition reservation
 * hook), so forking it costs nothing and lets `WorkflowsService.resumeRun`/
 * `cancelRun` go through the guarded, outbox-emitting path instead of writing
 * `status` directly. `CreditsModule` is itself a leaf that never imports
 * Workflows/Employees/Skills/WorkflowRuntime back, so this stays cycle-safe.
 *
 * Keep it a leaf.
 */
@Module({
  imports: [CreditsModule],
  providers: [RunStateWriter],
  exports: [RunStateWriter],
})
export class RunStateModule {}
