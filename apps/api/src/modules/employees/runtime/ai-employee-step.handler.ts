import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NodeRegistry } from '../../workflows/engine/node-registry.service';
import { resolveTemplate } from '../../workflows/engine/template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from '../../workflows/engine/nodes/node-handler';
import { AgentRuntimeService } from './agent-runtime.service';

/** Bound on tool calls per step — matches the chat runtime's own ceiling. */
const DEFAULT_MAX_TOOL_CALLS = 3;

/**
 * P2-03 — AI_EMPLOYEE_STEP.
 *
 * Runs a FULL AI Employee turn (plan → retrieve → memory → act → validate) by
 * delegating to `AgentRuntimeService`, rather than a bare LLM completion like
 * AI_STEP. Every tool call therefore inherits the chat path's behaviour,
 * including the G25 approval gate and per-employee budget enforcement.
 *
 * ── Why this handler lives in EmployeesModule, not with the others ──────────
 * `AgentRuntimeService` needs `ToolExecutorService`, which needs
 * ApprovalsModule. ApprovalsModule already imports WorkflowsModule (WORKFLOW
 * approvals call WorkflowsService). So if WorkflowsModule imported
 * EmployeesModule to get this handler, the result would be
 * `Approvals → Workflows → Employees → Approvals` — the exact cycle the module
 * graph is designed to avoid.
 *
 * Instead this handler is provided by EmployeesModule and registers ITSELF into
 * the `NodeRegistry` that WorkflowsModule exports. The edge is
 * `Employees → Workflows`, which closes no cycle because WorkflowsModule
 * imports neither Employees nor Approvals. Registration happens at boot, long
 * before any node executes, so ordering does not matter.
 */
@Injectable()
export class AiEmployeeStepNodeHandler implements NodeHandler, OnModuleInit {
  readonly type = 'AI_EMPLOYEE_STEP' as const;
  private readonly logger = new Logger(AiEmployeeStepNodeHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: AgentRuntimeService,
    private readonly registry: NodeRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('AI_EMPLOYEE_STEP registered with the node registry');
  }

  async execute({
    companyId,
    node,
    context,
    dryRun,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const employeeId = resolveTemplate(cfg.employeeId, context).trim();
    const instruction = resolveTemplate(cfg.instruction, context).trim();

    if (!employeeId) {
      throw new Error(`AI_EMPLOYEE_STEP node "${node.id}" has no employeeId`);
    }
    if (!instruction) {
      throw new Error(
        `AI_EMPLOYEE_STEP node "${node.id}" resolved an empty instruction template`,
      );
    }

    // Author-supplied id — verify tenancy before doing anything with it.
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: employeeId, companyId },
    });
    if (!employee) {
      throw new Error(
        `AI_EMPLOYEE_STEP node "${node.id}": employee "${employeeId}" not found in this company`,
      );
    }

    // A full turn can call real tools and spend real money, so a dry run stops
    // here — before the runtime, not inside it.
    if (dryRun) {
      const preview = {
        dryRun: true,
        employeeId,
        employeeName: employee.name,
        instruction,
        preview:
          'Would run a full AI Employee turn — no LLM call, no tool call, nothing sent.',
      };
      return { output: preview, contextValue: preview };
    }

    // A real Conversation so the turn is auditable in the same place chat turns
    // are, rather than invisible workflow-only history.
    const conversation = await this.prisma.conversation.create({
      data: {
        companyId,
        employeeId,
        title: `Workflow step ${node.id}`,
      },
    });

    // doc 27 §0.3 / doc 28 §0.4: an AI_EMPLOYEE_STEP "recommends only". It runs
    // with NO tools, so it can never take a person-facing or irreversible action
    // (candidate email, publish, access revocation) autonomously — even if the
    // employee is granted the skill — and a prompt-injected instruction in
    // {{trigger.payload}} can influence the draft but has no tool to abuse.
    // Side effects are explicit, human-gated TOOL_ACTION nodes downstream.
    // (disableTools rather than force-approval: a tool-approval created inside
    // this step would be TOOL-kind with no workflowRunId and could not resume
    // the run, orphaning it WAITING — offering no tools avoids that entirely.)
    const result = await this.runtime.run(employee, conversation, instruction, {
      disableTools: true,
    });

    const maxToolCalls = this.maxToolCalls(cfg);
    const toolCalls = result.toolCalls;
    if (toolCalls.length > maxToolCalls) {
      // Bound is advisory after the fact — the runtime owns its own ACT loop
      // cap — but exceeding it is worth surfacing rather than swallowing,
      // because unbounded tool calling is a cost incident.
      this.logger.warn(
        `AI_EMPLOYEE_STEP node=${node.id} employee=${employeeId} made ${toolCalls.length} tool calls (configured max ${maxToolCalls})`,
      );
    }

    // A gated tool call PAUSES the run rather than failing it (doc 17 §7.7).
    // The handler cannot pause by itself, so it returns a `pause` directive and
    // the engine sets the run WAITING with `resumeNodeId` = this node — the
    // step's work has not happened yet, so it must re-run once the approval is
    // decided. Failing here instead would force the operator to restart the
    // whole workflow by hand.
    const pending = toolCalls.find((call) => call.pendingApproval);
    if (pending) {
      this.logger.log(
        `ai_employee_step paused node=${node.id} employee=${employeeId} ` +
          `awaiting approval=${pending.approvalId} for ${pending.skillKey}.${pending.tool}`,
      );
      return {
        output: {
          employeeId,
          conversationId: conversation.id,
          awaitingApproval: true,
          approvalId: pending.approvalId ?? null,
          skillKey: pending.skillKey,
          tool: pending.tool,
        },
        pause: {
          reason: `awaiting approval for ${pending.skillKey}.${pending.tool}`,
          approvalId: pending.approvalId ?? undefined,
          resumeAtSelf: true,
        },
      };
    }

    this.logger.log(
      `ai_employee_step node=${node.id} employee=${employeeId} company=${companyId} tools=${toolCalls.length}`,
    );

    // RunResultDto exposes the persisted assistant MESSAGE, not a bare string.
    const text = result.message.content;
    const output = {
      employeeId,
      employeeName: employee.name,
      conversationId: conversation.id,
      messageId: result.message.id,
      instruction,
      text,
      plan: result.plan,
      toolCalls,
      sources: result.sources,
      validation: result.validation,
    };
    return { output, contextValue: text };
  }

  private maxToolCalls(cfg: Record<string, unknown>): number {
    const requested = Number(cfg.maxToolCalls);
    return Number.isFinite(requested) && requested > 0
      ? Math.min(requested, 10)
      : DEFAULT_MAX_TOOL_CALLS;
  }
}
