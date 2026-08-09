import { z } from 'zod';
import type { WorkflowDefinition } from '@vaep/types';
import type { Prisma } from '@prisma/client';
import { extractJson } from '../../../common/json/extract-json';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { collectDefinitionIssues } from '../../workflows/engine/definition-validator';
import { MAX_WORKFLOW_NODES } from '../../workflows/workflows.constants';
import { isFrozenNodeType, rejectionFor } from './frozen-node-types';
import { resolveReferences } from './graph-references';
import { type AssistTool, params } from './assist-tool-registry';
import { SkillCatalog } from '../../skills/catalog';

/**
 * The agent's WRITE + TERMINAL tools.
 *
 * `propose_graph` replaces the whole draft. That is deliberate for CREATION:
 * models are reliably good at emitting one small complete graph and reliably bad
 * at long sequences of mutations. Editing an existing 20-step workflow is the
 * opposite case and gets `patch_graph` instead (wave A7) — re-emitting a large
 * graph invites silent drops.
 *
 * Nothing here can reach a real `Workflow`. The draft lives on the session until
 * a human accepts it (doc 30 AD-30-05), so the worst a bad proposal costs is one
 * more turn.
 */

export function makeWriteTools(prisma: PrismaService): AssistTool<never>[] {
  return [
    proposeGraph(prisma),
    requestConnection(),
    finish(prisma),
  ] as unknown as AssistTool<never>[];
}

// ── request_connection ───────────────────────────────────────────────────────

const requestConnectionSchema = z.object({
  // Flat/shallow params (doc 00 §0.7): a comma-separated list, not an array.
  skillKeys: z.string().trim().min(1),
});

/**
 * Surface the in-chat Skill CARD for one or more skills the workflow needs. The
 * agent calls this the moment it knows a required skill may not be connected —
 * BEFORE or WITHOUT a full graph — so the user can connect it right in the chat
 * (doc 30 §12). The server resolves live connection status and renders the card;
 * this tool only declares which skills to ask for. Never terminal: the agent
 * keeps going (usually straight to `finish`) after asking.
 */
function requestConnection(): AssistTool<z.infer<typeof requestConnectionSchema>> {
  return {
    name: 'request_connection',
    description:
      'Ask the user to connect skills the workflow needs (e.g. gmail, calendar, slack). Call this AS SOON AS you know a required skill might not be connected — you do NOT need a finished graph first. A connection card appears in the chat so the user connects it without leaving. `skillKeys` is a comma-separated list of keys from list_skills, e.g. "gmail,calendar". Never tell the user you cannot connect a skill — call this instead.',
    schema: requestConnectionSchema,
    parameters: params(
      {
        skillKeys: {
          type: 'string',
          description: 'Comma-separated skill keys from list_skills, e.g. "gmail,calendar".',
        },
      },
      ['skillKeys'],
    ),
    run: async (_ctx, args) => {
      const keys = [
        ...new Set(
          args.skillKeys
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        ),
      ];
      const known = keys.filter((k) => SkillCatalog.has(k));
      const unknown = keys.filter((k) => !SkillCatalog.has(k));
      if (known.length === 0) {
        return {
          ok: false,
          summary: 'No known skills to connect',
          result: {
            error: `None of those are real skills. Use skillKeys exactly as list_skills returns them.${
              unknown.length ? ` Unknown: ${unknown.join(', ')}.` : ''
            }`,
          },
        };
      }
      return {
        ok: true,
        summary: `Asked to connect ${known.join(', ')}`,
        result: {
          // The agent-service reads this to render the card + persist it.
          requestedConnectionSkills: known,
          note:
            'A connection card is now shown to the user for these skills. Tell them ' +
            'they can connect right there and you will continue once done. Do NOT say you cannot connect it.',
        },
      };
    },
  };
}

// ── propose_graph ────────────────────────────────────────────────────────────

const proposeGraphSchema = z.object({
  // A JSON *string*, not an object: `ToolParametersDto` is one level deep and
  // primitives only, so structured input has to arrive serialised.
  definition: z.string().min(2),
  rationale: z.string().trim().min(1).max(1000),
});

function proposeGraph(
  prisma: PrismaService,
): AssistTool<z.infer<typeof proposeGraphSchema>> {
  return {
    name: 'propose_graph',
    description:
      'Save the workflow you have designed. `definition` is a JSON string {"nodes":[{"id","type","name","config"}],"edges":[{"from","to","branch"}]}. Exactly one TRIGGER, and it must be the first step. Call list_node_types and list_skills first so every step is real.',
    schema: proposeGraphSchema,
    parameters: params(
      {
        definition: {
          type: 'string',
          description:
            'The whole workflow graph as a JSON string: {"nodes":[…],"edges":[…]}.',
        },
        rationale: {
          type: 'string',
          description:
            'One or two plain sentences on why this shape solves the user\'s problem.',
        },
      },
      ['definition', 'rationale'],
    ),
    run: async (ctx, args) => {
      // Tolerant parse: a model that wraps its JSON in a fence should not lose
      // its turn over punctuation (G35).
      const parsed = extractJson<WorkflowDefinition>(args.definition);
      if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        return {
          ok: false,
          summary: 'Proposed graph was not valid JSON',
          result: {
            error:
              'I could not read that as a workflow. Send `definition` as a JSON string with "nodes" and "edges" arrays.',
          },
        };
      }

      if (parsed.nodes.length === 0) {
        return {
          ok: false,
          summary: 'Proposed graph was empty',
          result: { error: 'The workflow had no steps in it.' },
        };
      }
      if (parsed.nodes.length > MAX_WORKFLOW_NODES) {
        return {
          ok: false,
          summary: `Proposed graph too large (${parsed.nodes.length} steps)`,
          result: {
            error: `A workflow can have at most ${MAX_WORKFLOW_NODES} steps; this had ${parsed.nodes.length}. Simplify it.`,
          },
        };
      }

      // Frozen-17 enforcement in CODE, not just in the prompt (G32). A model
      // that reaches for the retired AI_STEP/NOTIFY gets told what to use.
      const banned = parsed.nodes.filter((n) => !isFrozenNodeType(String(n.type)));
      if (banned.length > 0) {
        return {
          ok: false,
          summary: `Rejected ${banned.length} unavailable step type(s)`,
          result: {
            error: banned
              .map((n) => `[${n.id}] ${rejectionFor(String(n.type))}`)
              .join(' '),
          },
        };
      }

      // The SAME structural validator every human write path uses — no
      // assist-specific dialect can creep in.
      const issues = collectDefinitionIssues(parsed);
      if (issues.length > 0) {
        return {
          ok: false,
          summary: `Graph had ${issues.length} problem(s)`,
          result: {
            error: `The workflow isn't valid yet: ${issues
              .map((i) => `${i.nodeId ? `[${i.nodeId}] ` : ''}${i.message}`)
              .join(' · ')}`,
          },
        };
      }

      // References that don't resolve are NOT a rejection — they are honest
      // "needs your input" items carried to the UI.
      const unresolved = await resolveReferences(prisma, ctx.companyId, parsed);

      const session = await prisma.assistSession.update({
        where: { id: ctx.sessionId },
        data: {
          draftDefinition: parsed as unknown as Prisma.InputJsonObject,
          draftVersion: { increment: 1 },
        },
        select: { draftVersion: true },
      });

      return {
        ok: true,
        summary: `Saved a ${parsed.nodes.length}-step draft`,
        result: {
          saved: true,
          version: session.draftVersion,
          nodeCount: parsed.nodes.length,
          unresolved,
          note:
            unresolved.length > 0
              ? 'Saved. Some steps still need the user to fill something in — mention these plainly in your reply rather than implying the workflow is ready.'
              : 'Saved, and every step resolved to something real.',
        },
      };
    },
  };
}

// ── finish ───────────────────────────────────────────────────────────────────

const finishSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
});

function finish(prisma: PrismaService): AssistTool<z.infer<typeof finishSchema>> {
  return {
    name: 'finish',
    description:
      'Call this when the workflow is built and you have nothing else to do. Summarise what it does in plain language, and say clearly what still needs the user.',
    schema: finishSchema,
    // Terminal: control returns to the user and the turn ends.
    terminal: true,
    parameters: params(
      {
        summary: {
          type: 'string',
          description:
            'Plain-language description of what was built and anything still outstanding.',
        },
      },
      ['summary'],
    ),
    run: async (ctx, args) => {
      const session = await prisma.assistSession.findUnique({
        where: { id: ctx.sessionId },
        select: { draftDefinition: true },
      });
      const definition = session?.draftDefinition as WorkflowDefinition | null;
      const unresolved = definition
        ? await resolveReferences(prisma, ctx.companyId, definition)
        : [];

      return {
        ok: true,
        summary: 'Finished building',
        result: {
          done: true,
          nodeCount: definition?.nodes.length ?? 0,
          unresolved,
          summaryForUser: args.summary,
        },
      };
    },
  };
}
