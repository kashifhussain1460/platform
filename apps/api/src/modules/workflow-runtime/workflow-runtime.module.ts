import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AttemptLeaseService } from './attempt-lease.service';
import { EngineModeService } from './engine-mode';
import { NodeAttemptProcessor } from './node-attempt.processor';
import { OutboxRelayService } from './outbox-relay.service';
import { ReaperService } from './reaper.service';
import { RetryPolicyService } from './retry-policy.service';
import { RunAdvanceProcessor } from './run-advance.processor';
import { RunLockService } from './run-lock.service';
import { RunStateWriter } from './run-state-writer.service';
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
  ],
  providers: [
    RunLockService,
    AttemptLeaseService,
    RunStateWriter,
    // Control flow for the state machine: fan-out via WorkflowJoinState and
    // loop iteration via a persisted cursor. Lanes are GENUINELY concurrent
    // here — each is its own attempt job, so N workers run N lanes at once.
    TraversalService,
    RetryPolicyService,
    ReaperService,
    OutboxRelayService,
    EngineModeService,
    ...(queueWorkersEnabled()
      ? [RunAdvanceProcessor, NodeAttemptProcessor, WorkflowTimerProcessor]
      : []),
  ],
  exports: [
    RunLockService,
    AttemptLeaseService,
    RunStateWriter,
    TraversalService,
    RetryPolicyService,
    ReaperService,
    OutboxRelayService,
    EngineModeService,
  ],
})
export class WorkflowRuntimeModule {}
