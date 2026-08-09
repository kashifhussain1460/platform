import { z } from 'zod';

/**
 * Leaf module — deliberately has ZERO imports from `./index` or
 * `./response-schemas`.
 *
 * `index.ts` and `response-schemas.ts` import EACH OTHER (index.ts does
 * `export * from './response-schemas'`; response-schemas.ts imports these
 * schemas back for its runtime cross-checks). ES-module `export ... from`
 * declarations are hoisted ahead of a module's own body, so whichever of the
 * two is evaluated first ends up running the other's imports before its own
 * top-level `const` assignments have executed — a genuine circular-import
 * TDZ ("Cannot access 'X' before initialization"), reproduced live via
 * browser testing of /onboarding on 2026-08-02.
 *
 * The fix is structural, not cosmetic: these six schemas were the only
 * runtime VALUES response-schemas.ts needed from index.ts, and they don't
 * depend on anything else in either file. Moving them here gives both files
 * a one-directional edge to a common leaf instead of an edge to each other.
 */

/** Shared zod contract for KPI targets (web form + PATCH /employees/:id body). */
export const kpiTargetsSchema = z.object({
  tasksPerWeek: z.number().int().min(0).max(1000000).optional(),
  successRatePct: z.number().min(0).max(100).optional(),
  approvalsMax: z.number().int().min(0).max(1000000).optional(),
});

const workflowNodeSchema = z.object({
  id: z.string().min(1),
  // MUST stay in sync with the NodeType union in index.ts. The two are
  // separate hand-written definitions in this package, so widening one
  // without the other makes `z.infer` diverge from the published type.
  type: z.enum([
    'TRIGGER',
    'RETRIEVE',
    'AI_STEP',
    'TOOL_ACTION',
    'WAIT',
    'CONDITION',
    'NOTIFY',
    'APPROVAL',
    'AI_EMPLOYEE_STEP',
    'SWITCH',
    'PARALLEL',
    'JOIN',
    'LOOP',
    'TERMINATE',
    'SET_VARIABLE',
    'TRANSFORM',
    'MEMORY_READ',
    'MEMORY_WRITE',
    'NOOP',
  ]),
  name: z.string().max(200).optional(),
  config: z.record(z.unknown()),
  // Additive canvas position (Workflow Builder); dagre seeds any node without one.
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  // Additive author-disable (Workflow Builder "Deactivate"); the engine skips it.
  disabled: z.boolean().optional(),
});

const workflowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  // Free string, not an enum — SWITCH uses author-named branches (P2-02).
  branch: z.string().min(1).max(80).optional(),
});

/** Shared graph contract for a workflow definition. */
export const workflowDefinitionSchema = z.object({
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});

/** One EVENT-DSL predicate (path · op · optional value). Unknown op → invalid. */
export const conditionSchema = z.object({
  path: z.string().min(1).max(200),
  op: z.enum([
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'contains',
    'exists',
    'in',
  ]),
  value: z.unknown().optional(),
});

/**
 * Shared trigger-config contract (SCHEDULE everyMs/cron · EVENT eventType +
 * optional condition DSL). `conditions` is capped so a filter list stays sane.
 */
export const triggerConfigSchema = z.object({
  everyMs: z.number().int().min(15000).optional(),
  cron: z.string().min(1).max(120).optional(),
  eventType: z.string().min(1).max(120).optional(),
  conditions: z.array(conditionSchema).max(25).optional(),
});
