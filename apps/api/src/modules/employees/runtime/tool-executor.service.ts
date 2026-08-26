import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ToolCallDto, ToolDefinitionDto } from '@vaep/types';
import type { ExecutorContext } from '../../skills/executors/skill-executor';
import { SkillsService } from '../../skills/skills.service';
import { isExternalActionTool } from '../../skills/tool-approval-policy';
import { ApprovalService } from '../../approvals/approval.service';

/** Minimal shape the executor needs to resolve tools + evaluate approval policy. */
export interface ToolExecutorEmployee {
  id: string;
  companyId: string;
  approvalRules?: Prisma.JsonValue | null;
}

/**
 * Bridges the AI Employee runtime's ACT step to the Skills module. `listTools`
 * returns the tools available to an employee (assigned + enabled installed
 * skills); `call` runs one tool via SkillsService — but FIRST asks the Approval
 * Center whether the call is high-risk. If it is, the call is NOT executed:
 * instead a PENDING ApprovalRequest is created and a `pendingApproval` ToolCallDto
 * is returned for the runtime to record. Otherwise it executes as before
 * (SkillsService writes the SkillExecution audit row).
 */
@Injectable()
export class ToolExecutorService {
  readonly name = 'skills';

  constructor(
    private readonly skills: SkillsService,
    private readonly approvals: ApprovalService,
  ) {}

  /** Tools this employee may call this turn. Empty → the runtime skips tool use. */
  listTools(employee: ToolExecutorEmployee): Promise<ToolDefinitionDto[]> {
    return this.skills.getToolsForEmployee(employee.companyId, employee.id);
  }

  /**
   * Execute one tool and return its outcome (logged as a SkillExecution) — unless
   * it is high-risk, in which case route it to the Approval Center (PENDING) and
   * return a `pendingApproval` result WITHOUT executing.
   */
  async call(
    ctx: ExecutorContext,
    employee: ToolExecutorEmployee,
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
    forceApproval = false,
    forceApprovalForExternalActions = false,
  ): Promise<ToolCallDto> {
    // `forceApproval` makes EVERY tool call route to a human, regardless of the
    // catalog `highRisk` flag or the employee's approvalRules. Used by the
    // workflow AI_EMPLOYEE_STEP (doc 27 §0.3): the reasoning step "recommends
    // only", so any autonomous action it proposes is a structural approval
    // boundary — not a config flag a tenant can forget to set. This also
    // contains prompt-injected instructions: they can propose an action, never
    // execute one.
    //
    // `forceApprovalForExternalActions` (set by the CHAT path) gates only tools
    // that send to a person / mutate an external system / egress data, so an
    // agent driven by untrusted pasted content can't autonomously email or
    // exfiltrate — while still reading context autonomously. Read-only tools are
    // unaffected.
    const gated =
      forceApproval ||
      (forceApprovalForExternalActions && isExternalActionTool(skillKey, tool)) ||
      (await this.approvals.requiresApproval(employee, ctx.companyId, skillKey, tool));
    if (gated) {
      const request = await this.approvals.createRequest({
        companyId: ctx.companyId,
        employeeId: ctx.employeeId,
        conversationId: ctx.conversationId,
        skillKey,
        tool,
        args,
        description: `Proposed ${skillKey}.${tool} call awaiting approval`,
      });
      return {
        skillKey,
        tool,
        args,
        result: null,
        ok: false,
        pendingApproval: true,
        approvalId: request.id,
      };
    }
    return this.skills.runTool(ctx, skillKey, tool, args);
  }
}
