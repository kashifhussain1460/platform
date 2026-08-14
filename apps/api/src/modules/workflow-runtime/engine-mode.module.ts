import { Module } from '@nestjs/common';
import { EngineModeService } from './engine-mode';

/**
 * WAVE 1 (gap W1-f) — the cutover flag as a LEAF module.
 *
 * `WorkflowRuntimeModule` imports `WorkflowsModule` (for the node registry and
 * the approval gate), so `WorkflowsModule` cannot import it back to ask which
 * engine a company is on — that closes a cycle Nest refuses to instantiate.
 *
 * Forking the flag into its own dependency-free module is the same shape the
 * codebase already uses for `ApprovalRoutingModule` and `LlmModule`: the piece
 * two otherwise-ordered modules both need becomes a leaf that neither owns.
 *
 * `EngineModeService` depends on nothing but ConfigService, so this stays a true
 * leaf. Keep it that way — the moment it needs Prisma, the fork stops working.
 */
@Module({
  providers: [EngineModeService],
  exports: [EngineModeService],
})
export class EngineModeModule {}
