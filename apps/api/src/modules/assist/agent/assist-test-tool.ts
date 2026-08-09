import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
  AssistTestResult,
  AssistTestStep,
  WorkflowDefinition,
} from '@vaep/types';
import type { Prisma } from '@prisma/client';
import { extractJson } from '../../../common/json/extract-json';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import { collectDefinitionIssues } from '../../workflows/engine/definition-validator';
import { ASSIST_TEST_TIMEOUT_MS } from '../assist.constants';
import { applyGraphPatch, type GraphPatchOp } from './graph-patch';
import { isFrozenNodeType, rejectionFor } from './frozen-node-types';
import { resolveReferences } from './graph-references';
import { type AssistTool, params } from './assist-tool-registry';

const logger = new Logger('AssistTestTools');

/**
 * `patch_graph` and `dry_run_test` — the edit-and-verify pair.
 *
 * `dry_run_test` is the feature's credibility. An untested draft is a guess, and
 * the difference between "here's a workflow" and "here's a workflow, I ran it and
 * these steps worked" is the difference between a demo and a tool.
 *
 * ── Why it is SAFE to let an agent run a workflow ───────────────────────────
 * The engine already short-circuits `TOOL_ACTION` and `MEMORY_WRITE` when
 * `run.dryRun` is set (`tool-action.handler.ts`, `memory.handlers.ts`). So a test
 * can never send an email, post to a channel, move money or write memory. The
 * agent has NO tool that can start a real run — that is enforced by there simply
 * not being one, not by asking it nicely.
 */

export function makeTestTools(
  prisma: PrismaService,
  workflows: WorkflowsService,
): AssistTool<never>[] {
  return [patchGraph(prisma), dryRunTest(prisma, workflows)] as unknown as AssistTool<never>[];
}

// ── patch_graph ──────────────────────────────────────────────────────────────

const patchGraphSchema = z.object({
  ops: z.string().min(2),
  rationale: z.string().trim().min(1).max(500),
});

function patchGraph(
  prisma: PrismaService,
): AssistTool<z.infer<typeof patchGraphSchema>> {
  return {
    name: 'patch_graph',
    description:
      'Change part of the workflow without rebuilding it. `ops` is a JSON array, e.g. [{"op":"updateNodeConfig","id":"send","config":{"args":{"channel":"#hr"}}}]. Ops: addNode, removeNode, updateNodeConfig, renameNode, addEdge, removeEdge. Prefer this over propose_graph when editing something that already exists.',
    schema: patchGraphSchema,
    parameters: params(
      {
        ops: {
          type: 'string',
          description: 'A JSON array of change operations.',
        },
        rationale: {
          type: 'string',
          description: 'One plain sentence on what you are changing and why.',
        },
      },
      ['ops', 'rationale'],
    ),
    run: async (ctx, args) => {
      const ops = extractJson<GraphPatchOp[]>(args.ops);
      if (!Array.isArray(ops)) {
        return {
          ok: false,
          summary: 'Patch was not valid JSON',
          result: { error: 'Send `ops` as a JSON array of change operations.' },
        };
      }

      const session = await prisma.assistSession.findUnique({
        where: { id: ctx.sessionId },
        select: { draftDefinition: true },
      });
      const current = session?.draftDefinition as WorkflowDefinition | null;
      if (!current || current.nodes.length === 0) {
        return {
          ok: false,
          summary: 'Nothing to patch',
          result: {
            error:
              'There is no workflow yet. Use propose_graph to build the first version.',
          },
        };
      }

      const patched = applyGraphPatch(current, ops);
      if (!patched.ok) {
        return {
          ok: false,
          summary: 'Patch rejected',
          result: { error: patched.error },
        };
      }

      // Same structural gate as every other write path — a patch cannot smuggle
      // in a graph that `propose_graph` would have refused.
      const issues = collectDefinitionIssues(patched.definition);
      if (issues.length > 0) {
        return {
          ok: false,
          summary: `Patch would break the workflow (${issues.length} problem(s))`,
          result: {
            error: `That change would leave the workflow invalid: ${issues
              .map((i) => `${i.nodeId ? `[${i.nodeId}] ` : ''}${i.message}`)
              .join(' · ')}`,
          },
        };
      }

      const unresolved = await resolveReferences(
        prisma,
        ctx.companyId,
        patched.definition,
      );
      const updated = await prisma.assistSession.update({
        where: { id: ctx.sessionId },
        data: {
          draftDefinition: patched.definition as unknown as Prisma.InputJsonObject,
          draftVersion: { increment: 1 },
        },
        select: { draftVersion: true },
      });

      return {
        ok: true,
        summary: `Applied ${patched.applied} change(s)`,
        result: {
          saved: true,
          version: updated.draftVersion,
          nodeCount: patched.definition.nodes.length,
          unresolved,
        },
      };
    },
  };
}

// ── dry_run_test ─────────────────────────────────────────────────────────────

const dryRunSchema = z.object({
  sampleTrigger: z.string().optional(),
});

function dryRunTest(
  prisma: PrismaService,
  workflows: WorkflowsService,
): AssistTool<z.infer<typeof dryRunSchema>> {
  return {
    name: 'dry_run_test',
    description:
      'Actually run the workflow once with sample data to check it works. Nothing real happens — emails, messages and payments are simulated. Do this before you finish, and tell the user what you saw.',
    schema: dryRunSchema,
    parameters: params({
      sampleTrigger: {
        type: 'string',
        description:
          'Optional JSON object of sample trigger data, e.g. {"candidate":"Priya","email":"p@example.com"}.',
      },
    }),
    run: async (ctx, args) => {
      const session = await prisma.assistSession.findUnique({
        where: { id: ctx.sessionId },
        select: { draftDefinition: true },
      });
      const definition = session?.draftDefinition as WorkflowDefinition | null;
      if (!definition || definition.nodes.length === 0) {
        return {
          ok: false,
          summary: 'Nothing to test',
          result: { error: 'Build the workflow first, then test it.' },
        };
      }

      const banned = definition.nodes.filter((n) => !isFrozenNodeType(String(n.type)));
      if (banned.length > 0) {
        return {
          ok: false,
          summary: 'Cannot test — unsupported step types',
          result: { error: banned.map((n) => rejectionFor(String(n.type))).join(' ') },
        };
      }

      const issues = collectDefinitionIssues(definition);
      if (issues.length > 0) {
        return {
          ok: false,
          summary: `Cannot test — ${issues.length} problem(s)`,
          result: {
            error: `Fix these first: ${issues.map((i) => i.message).join(' · ')}`,
          },
        };
      }

      const trigger = args.sampleTrigger
        ? (extractJson<Record<string, unknown>>(args.sampleTrigger) ?? {})
        : {};

      let scratchId: string | null = null;
      try {
        // A REAL workflow row, because the engine executes from one. Inventing a
        // parallel in-memory execution path would fork engine behaviour and the
        // "test" would stop testing the thing that actually runs.
        const scratch = await workflows.createAssistScratch(
          ctx.companyId,
          definition,
          ctx.userId,
        );
        scratchId = scratch.id;

        const run = await workflows.createRun(
          ctx.companyId,
          scratch.id,
          ctx.userId,
          trigger,
          true, // 🔑 dryRun — the whole safety story
        );

        const finished = await pollRun(prisma, run.id, ASSIST_TEST_TIMEOUT_MS);
        const result = await buildResult(prisma, run.id, finished, definition);

        return {
          ok: result.status !== 'FAILED',
          summary: result.headline,
          result: { test: result },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          summary: 'Test could not run',
          result: { error: `I couldn't run the test: ${message}` },
        };
      } finally {
        // `finally`, always — a leaked scratch workflow would show up in the
        // user's list as a mystery. (The retention sweep also mops up any that
        // escape a hard crash.)
        if (scratchId) {
          await prisma.workflow
            .delete({ where: { id: scratchId } })
            .catch((err: unknown) =>
              logger.warn(
                `could not delete scratch workflow ${scratchId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
        }
      }
    },
  };
}

async function pollRun(
  prisma: PrismaService,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'PENDING';
  while (Date.now() < deadline) {
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    status = run?.status ?? 'PENDING';
    // WAITING is terminal FOR A TEST: the run correctly paused at an approval
    // and will not move without a human.
    if (['COMPLETED', 'FAILED', 'WAITING', 'CANCELLED'].includes(status)) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return 'TIMED_OUT';
}

async function buildResult(
  prisma: PrismaService,
  runId: string,
  status: string,
  definition: WorkflowDefinition,
): Promise<AssistTestResult> {
  const rows = await prisma.workflowStepRun.findMany({
    where: { runId },
    orderBy: { startedAt: 'asc' },
  });
  const nameOf = new Map(
    definition.nodes.map((n) => [n.id, n.name ?? n.id] as const),
  );

  const steps: AssistTestStep[] = rows.map((row) => {
    const output = (row.output ?? {}) as Record<string, unknown>;
    return {
      nodeId: row.nodeId,
      name: nameOf.get(row.nodeId) ?? row.nodeId,
      status: row.status as AssistTestStep['status'],
      ms:
        row.finishedAt && row.startedAt
          ? row.finishedAt.getTime() - row.startedAt.getTime()
          : 0,
      // The engine stamps `dryRun: true` on any output it short-circuited. That
      // flag is what the UI turns into the "Simulated" chip, so it comes from
      // the ENGINE rather than being guessed from the node type.
      simulated: output.dryRun === true,
      ...(row.error ? { error: row.error } : {}),
      ...(row.output
        ? { outputPreview: preview(row.output) }
        : {}),
    };
  });

  return {
    runId,
    status: normaliseStatus(status),
    steps,
    headline: headlineFor(status, steps),
  };
}

function normaliseStatus(status: string): AssistTestResult['status'] {
  if (status === 'COMPLETED' || status === 'WAITING' || status === 'FAILED') {
    return status;
  }
  return 'TIMED_OUT';
}

/** Written by the SERVER, in plain words — not left to the model to narrate. */
function headlineFor(status: string, steps: AssistTestStep[]): string {
  const done = steps.filter((s) => s.status === 'COMPLETED').length;
  const simulated = steps.filter((s) => s.simulated).length;
  const tail =
    simulated > 0
      ? ` ${simulated} step${simulated === 1 ? ' was' : 's were'} simulated — nothing was really sent.`
      : '';

  switch (status) {
    case 'COMPLETED':
      return `Ran end to end: ${done} step${done === 1 ? '' : 's'} completed.${tail}`;
    case 'WAITING':
      // Deliberately reported as SUCCESS: pausing is the approval doing its job.
      return `Ran up to the approval and correctly paused there for a person to decide.${tail}`;
    case 'FAILED': {
      const failed = steps.find((s) => s.status === 'FAILED');
      return `Stopped at "${failed?.name ?? 'a step'}"${failed?.error ? `: ${failed.error}` : ''}.`;
    }
    default:
      return `The test took too long and was stopped after ${done} step${done === 1 ? '' : 's'}.`;
  }
}

/** Truncated + JSON-safe, so a huge tool payload can't bloat the prompt. */
function preview(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}
