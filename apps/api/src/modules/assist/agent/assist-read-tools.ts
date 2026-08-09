import { z } from 'zod';
import type { WorkflowDefinition } from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SkillCatalog } from '../../skills/catalog';
import { NODE_CATALOG } from '../../workflows/engine/nodes/node-catalog';
import { collectDefinitionIssues } from '../../workflows/engine/definition-validator';
import { FROZEN_NODE_TYPES, isFrozenNodeType } from './frozen-node-types';
import {
  type AssistTool,
  type AssistToolContext,
  params,
  noParams,
} from './assist-tool-registry';
import { resolveReferences } from './graph-references';

/**
 * The agent's READ tools — cheap, side-effect free, callable freely.
 *
 * Everything the model knows about the tenant arrives through these rather than
 * being stuffed into the system prompt. Two reasons: the prompt stays small (the
 * catalogs are large and mostly irrelevant to any one build), and every fact the
 * model used is traceable to a logged tool call.
 *
 * Each closes a specific gap in the older generator:
 *   G32/G33 — `list_node_types` serves the real NODE_CATALOG, filtered to the
 *             frozen 17. The generator hardcoded 8 types in its prompt, two of
 *             them retired, and never read the catalog at all.
 *   G34     — `list_skills` returns each tool's full `ToolParametersDto`, not
 *             just its name, so the model can fill `args` correctly instead of
 *             guessing the shape.
 *   G37     — `list_employees` returns ACTIVE employees only. The generator
 *             offered paused/disabled ones, producing workflows that can't run.
 */

export function makeReadTools(prisma: PrismaService): AssistTool<never>[] {
  return [
    listNodeTypes(),
    listSkills(prisma),
    listEmployees(prisma),
    listTemplates(prisma),
    inspectGraph(prisma),
  ] as unknown as AssistTool<never>[];
}

// ── list_node_types ──────────────────────────────────────────────────────────

const listNodeTypesSchema = z.object({
  category: z.string().trim().min(1).optional(),
});

function listNodeTypes(): AssistTool<z.infer<typeof listNodeTypesSchema>> {
  return {
    name: 'list_node_types',
    description:
      'List the step types you may use, with what each does and its exact config fields. Call this before proposing a graph.',
    schema: listNodeTypesSchema,
    parameters: params({
      category: {
        type: 'string',
        description:
          'Optional filter, e.g. TRIGGER, AI_EMPLOYEE, LOGIC, SKILL, APPROVAL, KNOWLEDGE, MEMORY, VARIABLE, UTILITY.',
      },
    }),
    run: (_ctx, args) => {
      const wanted = args.category?.toUpperCase();
      const defs = FROZEN_NODE_TYPES.map((t) => NODE_CATALOG[t])
        .filter((d) => !wanted || d.category === wanted)
        .map((d) => ({
          type: d.type,
          category: d.category,
          label: d.label,
          description: d.description,
          inputs: d.inputs,
          outputs: d.outputs,
          // The whole point of G33: the model gets the REAL required fields.
          configFields: d.configSchema.map((f) => ({
            key: f.key,
            type: f.type,
            required: f.required ?? false,
            help: f.help,
            options: f.options?.map((o) => o.value),
          })),
        }));
      return Promise.resolve({
        ok: true,
        summary: `Read ${defs.length} step type(s)`,
        result: { nodeTypes: defs },
      });
    },
  };
}

// ── list_skills ──────────────────────────────────────────────────────────────

const listSkillsSchema = z.object({
  query: z.string().trim().min(1).optional(),
});

function listSkills(
  prisma: PrismaService,
): AssistTool<z.infer<typeof listSkillsSchema>> {
  return {
    name: 'list_skills',
    description:
      'List the skills this company has actually connected, and the exact tools + arguments each one accepts. A TOOL_ACTION step may ONLY use a skillKey/tool pair from here.',
    schema: listSkillsSchema,
    parameters: params({
      query: {
        type: 'string',
        description: 'Optional filter on skill name or key, e.g. "slack".',
      },
    }),
    run: async (ctx, args) => {
      const installed = await prisma.installedSkill.findMany({
        where: { companyId: ctx.companyId },
        select: { skillKey: true, connectionStatus: true, employeeId: true },
      });

      const seen = new Map<string, { connected: boolean }>();
      for (const row of installed) {
        const prev = seen.get(row.skillKey);
        const connected = row.connectionStatus === 'CONNECTED';
        // A skill installed twice (company-wide + per-employee) counts as
        // connected if ANY of its connections is.
        seen.set(row.skillKey, { connected: (prev?.connected ?? false) || connected });
      }

      const q = args.query?.toLowerCase();
      const skills = [...seen.entries()]
        .map(([skillKey, meta]) => {
          const def = SkillCatalog.get(skillKey);
          if (!def) return null;
          return {
            skillKey,
            name: def.name,
            connected: meta.connected,
            tools: def.tools.map((t) => ({
              tool: t.name,
              description: t.description,
              // G34: the full parameter contract, so `args` can be filled
              // correctly rather than invented.
              parameters: t.parameters,
              highRisk: t.highRisk ?? false,
            })),
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .filter(
          (s) =>
            !q ||
            s.skillKey.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q),
        );

      return {
        ok: true,
        summary: `Read ${skills.length} connected skill(s)`,
        result: {
          skills,
          note:
            skills.length === 0
              ? 'This company has no skills connected yet. You can still design the shape of the workflow, but say plainly that the action steps will need a connection before they can run.'
              : undefined,
        },
      };
    },
  };
}

// ── list_employees ───────────────────────────────────────────────────────────

const listEmployeesSchema = z.object({
  role: z.string().trim().min(1).optional(),
});

function listEmployees(
  prisma: PrismaService,
): AssistTool<z.infer<typeof listEmployeesSchema>> {
  return {
    name: 'list_employees',
    description:
      'List the AI Employees this company has hired and who can actually do work. An AI_EMPLOYEE_STEP must name one of these by id.',
    schema: listEmployeesSchema,
    parameters: params({
      role: {
        type: 'string',
        description: 'Optional role filter, e.g. HR, MARKETING, SALES.',
      },
    }),
    run: async (ctx, args) => {
      const employees = await prisma.aiEmployee.findMany({
        // G37: ACTIVE only. A paused or disabled employee cannot run a step, so
        // offering one produces a workflow that fails the moment it fires.
        where: {
          companyId: ctx.companyId,
          status: 'ACTIVE',
          ...(args.role ? { role: args.role.toUpperCase() as never } : {}),
        },
        select: { id: true, name: true, role: true, persona: true },
        orderBy: { createdAt: 'asc' },
      });
      return {
        ok: true,
        summary: `Read ${employees.length} active employee(s)`,
        result: {
          employees,
          note:
            employees.length === 0
              ? 'No AI Employees are hired and active. Any step that needs one will have to be flagged for the user to fill in.'
              : undefined,
        },
      };
    },
  };
}

// ── list_templates ───────────────────────────────────────────────────────────

const listTemplatesSchema = z.object({
  query: z.string().trim().min(1).optional(),
});

function listTemplates(
  prisma: PrismaService,
): AssistTool<z.infer<typeof listTemplatesSchema>> {
  return {
    name: 'list_templates',
    description:
      'Search ready-made workflow templates. If one already does what the user asked, say so instead of rebuilding it from scratch.',
    schema: listTemplatesSchema,
    parameters: params({
      query: {
        type: 'string',
        description: 'Optional search over template name, key and description.',
      },
    }),
    run: async (ctx, args) => {
      const rows = await prisma.workflowTemplate.findMany({
        // First-party templates have companyId null; a tenant may also author
        // its own. Both are legitimate suggestions.
        where: { OR: [{ companyId: null }, { companyId: ctx.companyId }] },
        select: {
          key: true,
          name: true,
          category: true,
          description: true,
        },
        take: 60,
      });

      const q = args.query?.toLowerCase();
      const templates = rows.filter(
        (t) =>
          !q ||
          t.key.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q),
      );

      return {
        ok: true,
        summary: `Read ${templates.length} template(s)`,
        result: { templates },
      };
    },
  };
}

// ── inspect_graph ────────────────────────────────────────────────────────────

function inspectGraph(prisma: PrismaService): AssistTool<Record<string, never>> {
  return {
    name: 'inspect_graph',
    description:
      "Look at the workflow you have built so far, with any problems found. Call this if you're unsure of the current state — for example after the user has edited it.",
    schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    parameters: noParams(),
    run: async (ctx: AssistToolContext) => {
      const session = await prisma.assistSession.findUnique({
        where: { id: ctx.sessionId },
        select: { draftDefinition: true, draftVersion: true },
      });
      const definition =
        (session?.draftDefinition as WorkflowDefinition | null) ?? null;

      if (!definition || definition.nodes.length === 0) {
        return {
          ok: true,
          summary: 'Graph is empty',
          result: { empty: true, version: session?.draftVersion ?? 0 },
        };
      }

      const issues = collectDefinitionIssues(definition);
      const unresolved = await resolveReferences(prisma, ctx.companyId, definition);
      const nonFrozen = definition.nodes
        .filter((n) => !isFrozenNodeType(n.type))
        .map((n) => n.id);

      return {
        ok: true,
        summary: `Inspected ${definition.nodes.length} step(s), ${issues.length} problem(s)`,
        result: {
          version: session?.draftVersion ?? 0,
          definition,
          issues,
          unresolved,
          nonFrozenNodeIds: nonFrozen,
        },
      };
    },
  };
}
