/**
 * POC-07 — THE decisive test: can the Workflow SDK execute an Orlixa workflow
 * that exists only as JSON in Postgres? POC ONLY, NOT PRODUCTION.
 *
 * Orlixa workflows are authored by AI Assist and stored as
 * `WorkflowVersion.definition`. There is no TypeScript function per workflow and
 * there never will be, so the SDK's `"use workflow"` function has to be a
 * generic INTERPRETER whose input is the pinned graph.
 *
 * Design rules this file has to respect:
 *   - the workflow body is deterministic and side-effect free: it only walks the
 *     graph and decides what to call next;
 *   - every side effect is a `"use step"` and therefore memoized in the event log;
 *   - the definition is an ARGUMENT, so the run carries its own pinned version
 *     for its entire life (POC-08);
 *   - authorization stays on the Orlixa side, inside the step (POC-10);
 *   - the approval gate is a hook, and the approval record is Orlixa's (POC-09).
 */
import { createHook, getStepMetadata, sleep } from 'workflow';
import {
  evaluateCondition,
  nextNodeId,
  type OrlixaDefinition,
  type OrlixaNode,
} from '../orlixa/definitions';
import { createApproval } from '../orlixa/approval-store';
import { record } from '../orlixa/recorder';
import { executeSkill } from '../orlixa/skill-executor';

export interface OrlixaRunInput {
  /** Orlixa's own WorkflowRun.id — the SDK's runId is a SECOND identity. */
  runId: string;
  companyId: string;
  employeeId: string;
  workflowId: string;
  /** Orlixa's WorkflowVersion.id — pinned for the life of this run. */
  workflowVersionId: string;
  definition: OrlixaDefinition;
  trigger: Record<string, unknown>;
}

const MAX_STEPS = 50;

export async function runOrlixaDefinition(input: OrlixaRunInput) {
  'use workflow';

  const context: Record<string, unknown> = { trigger: input.trigger };
  const visited: string[] = [];

  let nodeId: string | undefined = input.definition.nodes[0]?.id;
  let guard = 0;

  while (nodeId && guard < MAX_STEPS) {
    guard += 1;
    const node: OrlixaNode | undefined = input.definition.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return { status: 'FAILED', reason: `Unknown node ${nodeId}`, visited, context };
    }

    if (node.disabled) {
      visited.push(`${node.id}:SKIPPED`);
      nodeId = nextNodeId(input.definition, node.id);
      continue;
    }

    visited.push(node.id);
    let branch: string | undefined;

    if (node.type === 'TRIGGER') {
      // Nothing to execute; the trigger payload is already in context.
    } else if (node.type === 'AI_EMPLOYEE_STEP') {
      context[node.id] = await aiEmployeeStep(input, node.id, String(node.config?.prompt ?? ''));
    } else if (node.type === 'CONDITION') {
      // PURE — deliberately not a step. Re-evaluating it on replay is free and
      // must produce the same answer, which is what determinism buys us.
      branch = evaluateCondition(node, context) ? 'true' : 'false';
      context[`${node.id}.branch`] = branch;
    } else if (node.type === 'WAIT') {
      await sleep(String(node.config?.duration ?? '1s'));
    } else if (node.type === 'APPROVAL') {
      const token = `orlixa:approval:${input.runId}:${node.id}`;
      const hook = createHook<{ approved: boolean; decidedBy: string }>({ token });
      // The APPROVAL ROW is Orlixa's, created in a step so it is memoized and
      // therefore created exactly once even though the body replays.
      await openApproval(input, node.id, token);
      const decision = await hook;
      hook.dispose();
      context[`${node.id}.decision`] = decision;
      if (!decision.approved) {
        return {
          status: 'FAILED',
          reason: 'APPROVAL_REJECTED',
          rejectedBy: decision.decidedBy,
          visited,
          context,
        };
      }
    } else if (node.type === 'TOOL_ACTION') {
      const result = await toolActionStep(
        input,
        node.id,
        String(node.config?.skillTool ?? ''),
        (node.config?.args ?? {}) as Record<string, unknown>,
      );
      context[node.id] = result;
    }

    nodeId = nextNodeId(input.definition, node.id, branch);
  }

  return {
    status: 'COMPLETED',
    visited,
    context,
    pinnedVersionId: input.workflowVersionId,
  };
}

// ── Steps: one per Orlixa node KIND, not per node ───────────────────────────
// This is the piece that makes a data-defined graph executable: the set of step
// functions is finite and static (so the compiler can register them), while the
// graph that decides which ones run, in what order, is entirely dynamic.

async function aiEmployeeStep(input: OrlixaRunInput, nodeId: string, prompt: string) {
  'use step';
  const meta = getStepMetadata();
  record('dyn.ai_step', {
    orlixaRunId: input.runId,
    nodeId,
    sdkStepId: meta.stepId,
    versionId: input.workflowVersionId,
  });
  // Deterministic stand-in for the LLM call.
  return `draft(${prompt.length}) for ${input.workflowId}`;
}

async function toolActionStep(
  input: OrlixaRunInput,
  nodeId: string,
  skillTool: string,
  args: Record<string, unknown>,
) {
  'use step';
  const meta = getStepMetadata();
  return executeSkill({
    companyId: input.companyId,
    employeeId: input.employeeId,
    runId: input.runId,
    nodeId,
    skillTool,
    args,
    idempotencyKey: meta.stepId,
    executionId: meta.stepId,
  });
}

async function openApproval(input: OrlixaRunInput, nodeId: string, token: string) {
  'use step';
  const row = createApproval({
    id: `${input.runId}:${nodeId}`,
    companyId: input.companyId,
    runId: input.runId,
    nodeId,
    hookToken: token,
  });
  record('dyn.approval_opened', { approvalId: row.id, token });
  return row.id;
}
