import { BullModule } from '@nestjs/bullmq';
import { Module, type OnModuleInit } from '@nestjs/common';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { RunEventStreamService } from '../workflows/run-event-stream.service';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AttemptLeaseService } from './attempt-lease.service';
import { EngineModeModule } from './engine-mode.module';
import { NodeAttemptProcessor } from './node-attempt.processor';
import { OutboxRelayService } from './outbox-relay.service';
import { ReaperService } from './reaper.service';
import { RetryPolicyService } from './retry-policy.service';
import { RunAdvanceProcessor } from './run-advance.processor';
import { RunLockService } from './run-lock.service';
import { RunStateModule } from './run-state.module';
import { TraversalService } from './traversal.service';
import { WorkflowTimerProcessor } from './timer.processor';
import {
  WF_COMPENSATE_QUEUE,
  WF_DLQ_QUEUE,
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
  WF_TIMER_QUEUE,
} from './workflow-runtime.constants';

/**
 * P1-04…P1-07 — the durable execution runtime.
 *
 * Imports WorkflowsModule for the NodeRegistry only. The edge is
 * one-directional (runtime → workflows); WorkflowsModule must NOT import this
 * module back, or the cycle the codebase carefully avoids reappears.
 *
 * SAFETY: shipping this changes nothing. `EngineModeService` defaults every
 * company to `legacy_walk`, so the advance/attempt workers idle until a tenant
 * is explicitly opted in via `WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES`.
 * Rollback is flipping that value — not a deploy.
 *
 * The processors respect `QUEUE_WORKERS_ENABLED` so the HTTP-only serverless
 * deployment registers the queues as producers without hosting consumers.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: WF_RUN_ADVANCE_QUEUE },
      { name: WF_NODE_ATTEMPT_QUEUE },
      { name: WF_TIMER_QUEUE },
      { name: WF_COMPENSATE_QUEUE },
      { name: WF_DLQ_QUEUE },
    ),
    WorkflowsModule,
    // The cutover flag is a leaf module so WorkflowsModule can read it too
    // without importing this module back (W1-f).
    EngineModeModule,
    // Same reason: WorkflowsService needs the state writer for resume/cancel.
    RunStateModule,
  ],
  providers: [
    RunLockService,
    AttemptLeaseService,
    // Control flow for the state machine: fan-out via WorkflowJoinState and
    // loop iteration via a persisted cursor. Lanes are GENUINELY concurrent
    // here — each is its own attempt job, so N workers run N lanes at once.
    TraversalService,
    RetryPolicyService,
    ReaperService,
    OutboxRelayService,
    ...(queueWorkersEnabled()
      ? [RunAdvanceProcessor, NodeAttemptProcessor, WorkflowTimerProcessor]
      : []),
  ],
  exports: [
    RunLockService,
    AttemptLeaseService,
    RunStateModule,
    TraversalService,
    RetryPolicyService,
    ReaperService,
    OutboxRelayService,
    EngineModeModule,
  ],
})
export class WorkflowRuntimeModule implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly stream: RunEventStreamService,
  ) {}

  /**
   * WAVE 5 §5.5 — connect the relay to the SSE fan-out.
   *
   * Registered HERE rather than in WorkflowsModule because this module owns the
   * relay, and the edge is already one-directional (runtime → workflows). The
   * relay was shipped with this seam and no sink, so until now it drained the
   * outbox straight to nothing.
   */
  onModuleInit(): void {
    this.relay.registerSink(this.stream);
  }
}
