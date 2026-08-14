import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ApprovalRoutingModule } from '../approval-routing/approval-routing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkflowPermissionsModule } from '../workflow-permissions/workflow-permissions.module';
import { BillingModule } from '../billing/billing.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../employees/llm/llm.module';
import { SkillsModule } from '../skills/skills.module';
import { ApprovalGateService } from './engine/approval-gate.service';
import { WorkflowEngine } from './engine/workflow-engine.service';
import { NodeRegistry } from './engine/node-registry.service';
import { SecretResolverService } from './engine/secret-resolver.service';
import {
  NODE_HANDLERS,
  NODE_HANDLER_PROVIDERS,
  type NodeHandler,
} from './engine/nodes';
import { WorkflowGeneratorService } from './engine/workflow-generator.service';
import { WorkflowProcessor } from './engine/workflow.processor';
import { RunEventsController } from './run-events.controller';
import { RunEventStreamService } from './run-event-stream.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowWebhooksController } from './webhooks.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowVersionService } from './workflow-version.service';
import { WorkflowReadinessService } from './readiness/workflow-readiness.service';
import { EngineModeModule } from '../workflow-runtime/engine-mode.module';
import { RunStateModule } from '../workflow-runtime/run-state.module';
import { WF_RUN_ADVANCE_QUEUE } from '../workflow-runtime/workflow-runtime.constants';
import { WORKFLOW_RUN_QUEUE } from './workflows.constants';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';

/**
 * Workflow builder module: tenant-scoped CRUD, run creation + a BullMQ
 * `workflow-run` queue, and the in-process WorkflowEngine/WorkflowProcessor that
 * walk the graph. The shared BullMQ connection is registered globally by the
 * KnowledgeModule (BullModule.forRootAsync), so only registerQueue is needed.
 *
 * Reuses other modules' singletons: KnowledgeModule (RETRIEVE), SkillsModule
 * (TOOL_ACTION), and LlmModule for the shared LlmProvider (AI_STEP). It imports
 * LlmModule directly rather than EmployeesModule so that ApprovalsModule can
 * import WorkflowsModule (WORKFLOW-kind decisions call WorkflowsService) without
 * closing a cycle: EmployeesModule imports ApprovalsModule, so a Workflows→
 * Employees edge would form Approvals→Workflows→Employees→Approvals. Workflows
 * does NOT import ApprovalsModule (the engine writes ApprovalRequest rows via
 * PrismaService directly) — the dependency stays one-directional Approvals→Workflows.
 * Also imports BillingModule so the engine can gate execution on the company's
 * subscription status (BillingModule has no imports of its own — a safe leaf).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: WORKFLOW_RUN_QUEUE }),
    // WAVE 1 — PRODUCER ONLY. The consumer lives in WorkflowRuntimeModule;
    // registering the same queue name in two modules gives this one the ability
    // to enqueue without importing (and cycling with) the runtime.
    BullModule.registerQueue({ name: WF_RUN_ADVANCE_QUEUE }),
    // Which engine a company's runs go to. Leaf module — see W1-f.
    EngineModeModule,
    // Guarded, outbox-emitting run transitions for resume/cancel (leaf).
    RunStateModule,
    KnowledgeModule,
    SkillsModule,
    LlmModule,
    BillingModule,
    // SecretResolverService decrypts connector credentials.
    CryptoModule,
    // P3-05 §8.1.3 — the engine resolves APPROVAL-node routing at pause time.
    // Dependency-light + acyclic (it imports neither Workflows nor Approvals).
    ApprovalRoutingModule,
    // P3-06 — enqueue-time `workflow:run` authz + the /permissions controller.
    WorkflowPermissionsModule,
    // System email when a run pauses at an APPROVAL / high-risk gate (leaf module).
    NotificationsModule,
  ],
  controllers: [
    WorkflowsController,
    WorkflowWebhooksController,
    RunEventsController,
  ],
  providers: [
    WorkflowsService,
    WorkflowVersionService,
    // UX plan §12 — the non-mutating publish preflight behind Review & Publish.
    WorkflowReadinessService,
    // P2-01: resolves {{secret.X}} at execution time so a credential is
    // never persisted into node config, step output or the run context.
    SecretResolverService,
    WorkflowEngine,
    WorkflowGeneratorService,
    // WAVE 5 §5.5 — fills the RunEventSink seam the outbox relay exposed.
    RunEventStreamService,
    // WAVE 1 §1.10 — the re-entrant APPROVAL gate the durable runtime consults
    // before every attempt at an APPROVAL node.
    ApprovalGateService,

    // P1-03 node registry. Adding a node type = write one handler and add it to
    // NODE_HANDLER_PROVIDERS below. Nothing in WorkflowEngine changes.
    ...NODE_HANDLER_PROVIDERS,
    {
      provide: NODE_HANDLERS,
      useFactory: (...handlers: NodeHandler[]) => handlers,
      inject: NODE_HANDLER_PROVIDERS,
    },
    NodeRegistry,

    ...(queueWorkersEnabled() ? [WorkflowProcessor] : []),
  ],
  exports: [
    WorkflowsService,
    WorkflowVersionService,
    NodeRegistry,
    SecretResolverService,
    ApprovalGateService,
    RunEventStreamService,
  ],
})
export class WorkflowsModule {}
