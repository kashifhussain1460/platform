import type {
  TriggerConfig,
  TriggerType,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowReadinessCheckDto,
  WorkflowReadinessDto,
  WorkflowReadinessIssueDto,
  WorkflowSkillRequirementDto,
} from '@vaep/types';
import { NODE_CATALOG } from '../engine/nodes/node-catalog';
import { collectDefinitionIssues } from '../engine/definition-validator';

/**
 * PUBLISH READINESS — the pure evaluator behind `GET /workflows/:id/readiness`.
 *
 * The UX plan (§12) removes the standalone `[Validate]` button: validation is
 * part of Review & Publish. That only works if the frontend can ask "would this
 * publish succeed, and if not, why?" WITHOUT mutating anything. Publish already
 * enforces all of this — it just enforces it by throwing a single concatenated
 * BadRequest string, which is not something a non-technical operator can act on.
 *
 * So this re-uses the SAME rule sources rather than restating them:
 *  - `collectDefinitionIssues` — the exact validator publish/activate run.
 *  - `SkillRequirementsService` output — the exact connection gate publish runs.
 * and adds only what publish enforces elsewhere (trigger config, at-least-one
 * step) plus purely-advisory notes (an unrouted approval, unreachable steps).
 *
 * It is pure and I/O-free so the rules are unit-testable and so this can never
 * become a second, drifting source of truth: if the validator changes, this
 * changes with it.
 */

export interface ReadinessInput {
  workflowId: string;
  name: string;
  definition: WorkflowDefinition;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig | null;
  /** From SkillRequirementsService — the tenant's real connection state. */
  skillRequirements: WorkflowSkillRequirementDto[];
  /** Non-blocking structural warnings already computed for the WorkflowDto. */
  warnings: string[];
}

/** Minimum repeat interval BullMQ schedules are allowed to use. */
const MIN_INTERVAL_MS = 15_000;

function nodesOf(definition: WorkflowDefinition): WorkflowNode[] {
  return Array.isArray(definition?.nodes) ? definition.nodes : [];
}

function configOf(node: WorkflowNode): Record<string, unknown> {
  return (node.config ?? {}) as Record<string, unknown>;
}

function describeTrigger(
  triggerType: TriggerType,
  config: TriggerConfig | null,
): string {
  switch (triggerType) {
    case 'SCHEDULE':
      if (config?.cron) return `On a schedule (${config.cron})`;
      if (config?.everyMs) {
        const minutes = Math.round(config.everyMs / 60_000);
        return minutes >= 1
          ? `Every ${minutes} minute${minutes === 1 ? '' : 's'}`
          : `Every ${Math.round((config.everyMs ?? 0) / 1000)} seconds`;
      }
      return 'On a schedule (not set yet)';
    case 'WEBHOOK':
      return 'When something calls its webhook';
    case 'EVENT':
      return config?.eventType
        ? `When "${config.eventType}" happens`
        : 'On an event (not chosen yet)';
    default:
      return 'Manual — someone starts it';
  }
}

/**
 * Evaluate every check the Review & Publish surface shows. Never throws: an
 * unpublishable workflow is a normal state to REPORT, not an error.
 */
export function evaluateReadiness(input: ReadinessInput): WorkflowReadinessDto {
  const { definition, triggerType, triggerConfig, skillRequirements } = input;
  const nodes = nodesOf(definition);
  const steps = nodes.filter((n) => n.type !== 'TRIGGER');
  const issues: WorkflowReadinessIssueDto[] = [];

  const add = (
    code: string,
    severity: 'BLOCKER' | 'WARNING',
    message: string,
    nodeId: string | null = null,
    fix: WorkflowReadinessIssueDto['fix'] = null,
  ) => issues.push({ code, severity, message, nodeId, fix });

  // ── 1. Structure + node configuration (the real validator) ────────────────
  // Its INTEGRITY/READINESS split is about *when* a rule applies (save vs
  // publish). At publish time both block, which is exactly what this surface is
  // reporting on, so every issue it returns is a BLOCKER here.
  const validatorIssues = collectDefinitionIssues(definition);
  const structureCodes = new Set([
    'DUPLICATE_NODE_ID',
    'UNKNOWN_NODE_TYPE',
    'UNKNOWN_EDGE_SOURCE',
    'UNKNOWN_EDGE_TARGET',
    'GRAPH_TOO_LARGE',
    'CYCLE_DETECTED',
    'SINGLE_TRIGGER_REQUIRED',
    'TRIGGER_NOT_ENTRY',
    'MISSING_BRANCH_EDGE',
    'UNJOINED_PARALLEL',
    'NESTED_PARALLEL',
    'PARALLEL_NO_LANES',
    'SWITCH_NO_CASES',
    'UNKNOWN_LANE_START',
    'TERMINATE_HAS_OUTGOING_EDGE',
  ]);
  //
  // EVERY validator issue is a BLOCKER here, with no exceptions. That is not a
  // judgement call — `validateDefinitionStructure` (what publish calls) throws
  // on the whole collected list, so anything this downgrades to a warning
  // becomes a preflight that says "ready" followed by a publish that returns
  // 400. An earlier version treated UNREACHABLE_NODE as advisory on the
  // reasoning that an unreached step is harmless; publish disagreed, and the
  // browser showed exactly that contradiction. The rule is: predict publish,
  // don't second-guess it.
  let structureFailed = false;
  let nodeConfigFailed = false;
  for (const v of validatorIssues) {
    if (structureCodes.has(v.code) || v.code === 'UNREACHABLE_NODE') {
      structureFailed = true;
    } else {
      nodeConfigFailed = true;
    }
    add(
      v.code,
      'BLOCKER',
      v.message,
      v.nodeId,
      v.nodeId ? { kind: 'OPEN_NODE', target: v.nodeId } : null,
    );
  }

  // ── 2. At least one real step (what `activate` enforces) ──────────────────
  if (steps.length === 0) {
    structureFailed = true;
    add(
      'NO_STEPS',
      'BLOCKER',
      'This workflow has no steps yet. Add at least one step after the trigger.',
    );
  }

  // ── 3. Trigger configuration ──────────────────────────────────────────────
  let triggerFailed = false;
  if (triggerType === 'SCHEDULE') {
    const hasCron =
      typeof triggerConfig?.cron === 'string' && triggerConfig.cron.trim() !== '';
    const everyMs = Number(triggerConfig?.everyMs);
    const hasInterval = Number.isFinite(everyMs) && everyMs >= MIN_INTERVAL_MS;
    if (!hasCron && !hasInterval) {
      triggerFailed = true;
      add(
        'TRIGGER_INCOMPLETE',
        'BLOCKER',
        'Choose when this workflow should run — pick a frequency and time in the trigger.',
        null,
        { kind: 'OPEN_TRIGGER' },
      );
    }
  } else if (triggerType === 'EVENT') {
    if (!triggerConfig?.eventType) {
      triggerFailed = true;
      add(
        'TRIGGER_INCOMPLETE',
        'BLOCKER',
        'Choose which event should start this workflow.',
        null,
        { kind: 'OPEN_TRIGGER' },
      );
    }
  }

  // ── 4. Skills + connections ───────────────────────────────────────────────
  // `requiresConnection: false` skills (http, scheduling, …) are operational
  // once installed and must never block — mirrors the publish gate exactly.
  let skillsFailed = false;
  for (const req of skillRequirements) {
    if (!req.required || !req.requiresConnection) continue;
    if (req.status === 'READY') continue;
    skillsFailed = true;
    add(
      'SKILL_NOT_CONNECTED',
      'BLOCKER',
      req.canManageConnection
        ? `${req.displayName} isn't connected yet. Connect it so this workflow can use it.`
        : `${req.displayName} isn't connected yet. Ask an owner or admin to connect it.`,
      req.nodeIds[0] ?? null,
      { kind: 'CONNECT_SKILL', target: req.skillKey },
    );
  }

  // ── 5. Approval routing (advisory) ────────────────────────────────────────
  // An APPROVAL node with no routing rules is VALID: it falls back to "any
  // owner or admin decides". Reporting that as a blocker would be untrue, so it
  // is a warning that explains who will be asked.
  const approvalNodes = nodes.filter((n) => n.type === 'APPROVAL');
  let approvalWarned = false;
  for (const node of approvalNodes) {
    const cfg = configOf(node);
    if (cfg.autoApprove === true) continue;
    if (!cfg.routing) {
      approvalWarned = true;
      add(
        'APPROVAL_UNROUTED',
        'WARNING',
        `"${node.name ?? node.id}" will be sent to any owner or admin. Add routing if a specific person should decide.`,
        node.id,
        { kind: 'OPEN_NODE', target: node.id },
      );
    }
  }

  // ── 6. Structural warnings already computed for the DTO ───────────────────
  // The validator and `computeWarnings` both notice an unreachable step, and
  // word it DIFFERENTLY, so matching on the message text listed the same
  // problem twice (seen in the browser). De-duplicate on the node instead: any
  // DTO warning naming a node the validator already reported is dropped, and
  // the validator's version is kept because it carries the "open this step"
  // action.
  const reportedNodeIds = new Set(
    issues.map((i) => i.nodeId).filter((id): id is string => Boolean(id)),
  );
  const seenMessages = new Set(issues.map((i) => i.message));
  for (const warning of input.warnings) {
    if (seenMessages.has(warning)) continue;
    if ([...reportedNodeIds].some((id) => warning.includes(id))) continue;
    add('GRAPH_WARNING', 'WARNING', warning);
  }

  const ready = issues.every((i) => i.severity !== 'BLOCKER');

  const employeeIds = [
    ...new Set(
      nodes
        .map((n) => configOf(n).employeeId)
        .filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
    ),
  ];
  const skillKeys = [...new Set(skillRequirements.map((r) => r.skillKey))];
  const hasExternalActions = nodes.some(
    (n) => NODE_CATALOG[n.type]?.hasSideEffects === true,
  );

  const checks: WorkflowReadinessCheckDto[] = [
    {
      key: 'STRUCTURE',
      label: 'Workflow structure',
      status: structureFailed ? 'FAIL' : 'PASS',
    },
    {
      key: 'TRIGGER',
      label: 'Trigger',
      status: triggerFailed ? 'FAIL' : 'PASS',
    },
    {
      key: 'NODE_CONFIG',
      label: 'Step settings',
      status: nodeConfigFailed ? 'FAIL' : 'PASS',
    },
    {
      key: 'AI_EMPLOYEE',
      label: 'AI employees',
      status: 'PASS',
    },
    {
      key: 'SKILLS',
      label: 'Skills and connections',
      status: skillsFailed ? 'FAIL' : 'PASS',
    },
    {
      key: 'APPROVAL',
      label: 'Approvals',
      status: approvalWarned ? 'WARN' : 'PASS',
    },
  ];
  if (triggerType === 'SCHEDULE') {
    checks.push({
      key: 'SCHEDULE',
      label: 'Schedule',
      status: triggerFailed ? 'FAIL' : 'PASS',
    });
  }
  // AI_EMPLOYEE is derived from the validator's own employeeId rule rather than
  // re-checked here, so it only ever reports FAIL when that rule fired.
  const employeeIssue = issues.some(
    (i) => i.severity === 'BLOCKER' && /employeeId/i.test(i.message),
  );
  if (employeeIssue) {
    const check = checks.find((c) => c.key === 'AI_EMPLOYEE');
    if (check) check.status = 'FAIL';
  }

  return {
    workflowId: input.workflowId,
    ready,
    checks,
    issues,
    summary: {
      name: input.name,
      triggerSummary: describeTrigger(triggerType, triggerConfig),
      employeeIds,
      skillKeys,
      approvalCount: approvalNodes.length,
      stepCount: steps.length,
      hasExternalActions,
    },
  };
}
