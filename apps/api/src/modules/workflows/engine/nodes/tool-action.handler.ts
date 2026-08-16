import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { SkillCatalog } from '../../../skills/catalog';
import { SkillsService } from '../../../skills/skills.service';
import {
  findMissingRequiredArgs,
  resolveArgs,
  type MissingArg,
} from '../template';
import { SecretResolverService } from '../secret-resolver.service';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * TOOL_ACTION: run a skill tool with templated args → context[outputKey].
 *
 * Ported verbatim from WorkflowEngine.execToolAction (P1-03).
 *
 * NOTE ON THE G25 APPROVAL GATE: it is deliberately NOT here. The engine's run
 * loop checks `toolRequiresApproval` and PAUSES the whole run before any
 * handler is dispatched — a handler cannot pause a run, it can only return a
 * result. Moving the gate into this file would silently reintroduce the bypass
 * G25 closed. Leave it in the loop.
 */
/**
 * Turn missing arguments into a sentence the person reading the run page can
 * act on: which step, which field, and where the value was supposed to come
 * from. The generic advice at the end covers the common cause — starting an
 * event-driven workflow by hand, so nothing ever produced the trigger data the
 * step reads.
 */
function describeMissingArgs(nodeId: string, missing: MissingArg[]): string {
  const parts = missing.map(({ arg, refs }) =>
    refs.length > 0
      ? `"${arg}" is set to ${refs.map((r) => `{{${r}}}`).join(' + ')}, and this run produced no value for that`
      : `"${arg}" is empty`,
  );
  // Only blame the trigger when the empty reference actually reads from it.
  // Saying "a workflow started by hand has no trigger data" about a value an
  // EARLIER STEP was supposed to produce sends the reader to the wrong end of
  // their workflow — seen on a real run where the missing body came from a
  // preceding AI step.
  const fromTrigger = missing.some((m) =>
    m.refs.some((r) => r === 'trigger' || r.startsWith('trigger.')),
  );
  const advice = fromTrigger
    ? 'A workflow started by hand has no trigger data, so steps that read from the trigger have nothing to read.'
    : 'Check the step that was supposed to produce it — a step\'s result is only readable if it sets an outputKey.';
  return (
    `Step "${nodeId}" is missing required information: ${parts.join('; ')}. ` +
    `Nothing was sent. ${advice}`
  );
}

@Injectable()
export class ToolActionNodeHandler implements NodeHandler {
  readonly type = 'TOOL_ACTION' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    private readonly secrets: SecretResolverService,
  ) {}

  async execute({
    companyId,
    workflowId,
    node,
    context,
    dryRun,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const skillKey = typeof cfg.skillKey === 'string' ? cfg.skillKey : '';
    const tool = typeof cfg.tool === 'string' ? cfg.tool : '';
    const argsRaw =
      cfg.args && typeof cfg.args === 'object' && !Array.isArray(cfg.args)
        ? (cfg.args as Record<string, unknown>)
        : undefined;
    const args = resolveArgs(argsRaw, context);
    // Same convention as AI_STEP's cfg.employeeId: run as this employee's own
    // connection when set, so a company that only connected this skill
    // per-employee (no company-wide row) can still be reached from a workflow.
    // Without this, resolveInstalledForExecution would never find the
    // employee-owned row and the step would silently run against the executor's
    // "not connected" mock fallback even though a real connection exists.
    const employeeId =
      typeof cfg.employeeId === 'string' && cfg.employeeId.trim()
        ? cfg.employeeId.trim()
        : undefined;

    // Validate BEFORE the dry-run short-circuit below: a dry run previewing
    // "ok:true" for a skill/tool reference that would fail for real (unknown,
    // or a quarantined connector) defeats the whole point of a safe preview —
    // it must catch every failure a real run would hit, just without the real
    // side effect. Same existence check runTool() uses.
    const toolDef = SkillCatalog.getTool(skillKey, tool);
    if (!toolDef) {
      throw new Error(`Unknown skill/tool: ${skillKey}/${tool}`);
    }

    // A required argument that templated down to nothing must stop the step
    // HERE, not at the provider. Sending `to: ""` to Gmail comes back as
    // "Gmail API error (400): Recipient address required" — a message that
    // names neither the step, the argument, nor the placeholder that was empty,
    // so the run page tells the customer nothing they can act on. It also
    // spends a real API call on a request that cannot succeed.
    const missing = findMissingRequiredArgs(
      argsRaw,
      args,
      context,
      toolDef.parameters?.required ?? [],
    );
    if (missing.length > 0) {
      throw new Error(describeMissingArgs(node.id, missing));
    }

    // Quarantine (docs §5.5): if this skill's connector is DEGRADED or
    // DISCONNECTED, fail the step with a clear, non-retryable "connector
    // unavailable" error rather than hammer a dead provider. Only applies when
    // the skill is installed as a connector AND currently unhealthy — a
    // not-installed or CONNECTED/NOT_CONNECTED skill runs exactly as before.
    if (skillKey) {
      // Same priority as resolveInstalledForExecution: the employee-owned row
      // first (if this step runs as one), else the company-wide row.
      // findFirst rather than findUnique on the compound key: Prisma's
      // compound-unique type requires a non-null employeeId even though the
      // column is nullable.
      const ownConnector = employeeId
        ? await this.prisma.installedSkill.findFirst({
            where: { companyId, skillKey, employeeId },
            select: { connectionStatus: true },
          })
        : null;
      const connector =
        ownConnector ??
        (await this.prisma.installedSkill.findFirst({
          where: { companyId, skillKey, employeeId: null },
          select: { connectionStatus: true },
        }));
      if (
        connector &&
        (connector.connectionStatus === 'DEGRADED' ||
          connector.connectionStatus === 'DISCONNECTED')
      ) {
        throw new Error(
          `Connector for "${skillKey}" is ${connector.connectionStatus} — step quarantined (connector unavailable)`,
        );
      }
    }

    // Test mode: stop before ANY real interaction with SkillsService — no
    // connector lookup beyond the validation above, no egress, no
    // SkillExecution audit row. A dry run must be PROVABLY side-effect free,
    // not "run for real and hope nothing bad happens" — while still failing
    // loudly on a misconfigured step.
    if (dryRun) {
      const preview = {
        ok: true,
        dryRun: true,
        skillKey,
        tool,
        args,
        preview: `Would call ${skillKey}/${tool} with these args — nothing was actually sent.`,
      };
      return { output: preview, contextValue: preview };
    }

    // Resolve {{secret.X}} references at the LAST possible moment (P2-01).
    // `args` above is what gets persisted; `liveArgs` never is.
    const { resolved, used, secretValues } = await this.secrets.resolve(
      companyId,
      workflowId,
      args,
    );
    const liveArgs = resolved as Record<string, unknown>;

    // Runs through SkillsService (swappable executor) + writes a SkillExecution.
    const call = await this.skills.runTool(
      { companyId, employeeId, secretValues },
      skillKey,
      tool,
      liveArgs,
    );
    if (!call.ok) {
      // Carry the PROVIDER's error through. The previous message was
      // `Tool x/y did not succeed` and nothing else, which erased the cause of
      // every tool failure: a timeout, a 500 and a rate limit all produced the
      // same string, so `RetryPolicyService` — which classifies by reading the
      // message — filed every one of them as a generic `NODE_ERROR`.
      //
      // The cost was not cosmetic. Backoff, the retry decision, the failure
      // metrics and the DLQ all key off that class, and an operator looking at
      // a failed run could not tell a provider outage from a bad argument.
      // Proven by the chaos suite: a timeout was recorded as NODE_ERROR until
      // this line changed.
      const detail =
        typeof call.error === 'string' && call.error.trim()
          ? `: ${call.error.trim()}`
          : '';
      throw new Error(`Tool ${skillKey}/${tool} did not succeed${detail}`);
    }

    // Mask any credential the provider echoed back before it reaches step output
    // or the run context — a 401 body quoting the rejected token is exactly how
    // a secret ends up in a run log.
    if (used.length > 0) {
      const masked = this.secrets.mask(call, secretValues);
      return { output: masked, contextValue: masked };
    }
    return { output: call, contextValue: call };
  }
}
