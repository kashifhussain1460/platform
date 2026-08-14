import {
  CONDITION_OPS,
  NODE_TYPES,
  WRITABLE_VARIABLE_SCOPES,
} from '@vaep/types';
import type {
  ConditionOp,
  NodeDefinitionDto,
  NodeOutputHandle,
  NodeType,
} from '@vaep/types';

/**
 * THE workflow NODE CATALOG — code, not DB. The single source of truth for the
 * frontend Workflow Builder's node palette + Inspector: every registered
 * NodeType's category, human label/description, handle topology (inputs/
 * outputs) and config-field schema. Served by `GET /workflows/node-definitions`.
 *
 * This mirrors `modules/skills/catalog.ts` (SkillCatalog) deliberately: the
 * engine's node HANDLERS (`engine/nodes/*.handler.ts`) expose only `type` +
 * `execute()` — no ports, config schema, or flags — so this metadata is
 * authored here rather than derived from them. Canonical shapes come from doc 00
 * §0.7 (NodeCategory) and doc 02 §7 (NodeConfigField / NodeOutputHandle /
 * NodeDefinitionDto).
 *
 * The `Record<NodeType, …>` type makes COMPLETENESS a compile error: adding a
 * NodeType without a catalog entry fails `tsc`, and `node-catalog.spec.ts`
 * additionally asserts no drift against `NODE_TYPES` at test time (matching the
 * boot-completeness guarantee of the skills/template catalogs).
 *
 * Config field names are taken verbatim from the real per-node contracts — the
 * `*NodeConfig` interfaces in `@vaep/types`, the required-field rules in
 * `engine/definition-validator.ts`, and the handlers themselves — never
 * invented. `required` marks a field the validator/handler mandates or the
 * config interface types as non-optional; `templatable` marks a field the
 * handler resolves `{{templates}}` in.
 */

// ── Shared option lists ──────────────────────────────────────────────────────

const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  contains: 'contains',
  gt: 'greater than',
  lt: 'less than',
};

const CONDITION_OP_OPTIONS = CONDITION_OPS.map((op) => ({
  value: op,
  label: CONDITION_OP_LABELS[op],
}));

const MODE_OPTIONS = [
  { value: 'ALL', label: 'All lanes' },
  { value: 'ANY', label: 'First lane only' },
];

const MEMORY_KIND_OPTIONS = [
  { value: 'FACT', label: 'Fact' },
  { value: 'SUMMARY', label: 'Summary' },
];

const TERMINATE_STATUS_OPTIONS = [
  { value: 'COMPLETED', label: 'Completed (success)' },
  { value: 'FAILED', label: 'Failed' },
];

/** Only the scopes a workflow graph may WRITE (SET_VARIABLE). */
const WRITABLE_SCOPE_OPTIONS = WRITABLE_VARIABLE_SCOPES.map((scope) => ({
  value: scope,
  label: scope,
}));

/** VariableType minus `secret` — a graph can never coerce a value to a secret. */
const VARIABLE_TYPE_OPTIONS = (
  ['string', 'number', 'boolean', 'json', 'date', 'array'] as const
).map((type) => ({ value: type, label: type }));

// ── Shared handle topologies ─────────────────────────────────────────────────

/** The single unlabelled "continue" output most nodes have. */
const NEXT: NodeOutputHandle[] = [{ label: 'Next' }];

/** CONDITION's two boolean handles (edges tagged branch:'true'/'false'). */
const CONDITION_OUTPUTS: NodeOutputHandle[] = [
  { branch: 'true', label: 'Yes' },
  { branch: 'false', label: 'No' },
];

// ── The catalog ──────────────────────────────────────────────────────────────

/**
 * Every registered NodeType (`NODE_TYPES`) → its static metadata. The Record key
 * type forces this to stay complete at compile time.
 */
export const NODE_CATALOG: Record<NodeType, NodeDefinitionDto> = {
  // ── TRIGGER ────────────────────────────────────────────────────────────────
  TRIGGER: {
    type: 'TRIGGER',
    category: 'TRIGGER',
    label: 'Trigger',
    description:
      'Entry point. The run trigger payload is available to later nodes as {{trigger.*}}.',
    inputs: 0,
    outputs: [{ label: 'Start' }],
    configSchema: [],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  // ── KNOWLEDGE ────────────────────────────────────────────────────────────────
  RETRIEVE: {
    type: 'RETRIEVE',
    category: 'KNOWLEDGE',
    label: 'Retrieve knowledge',
    description:
      'Search the company knowledge base for a query and store the matching passages.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'query',
        label: 'Query',
        type: 'text',
        required: true,
        templatable: true,
        placeholder: '{{trigger.query}}',
        help: 'Text to search the knowledge base for.',
      },
      {
        key: 'k',
        label: 'Max results',
        type: 'number',
        default: 5,
        help: 'How many passages to return (clamped to 50).',
      },
      {
        key: 'outputKey',
        label: 'Save results as',
        type: 'string',
        required: true,
        default: 'retrieved',
        help: 'Later nodes read the results with {{<name>}}.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  // ── AI_EMPLOYEE ──────────────────────────────────────────────────────────────
  AI_STEP: {
    type: 'AI_STEP',
    category: 'AI_EMPLOYEE',
    label: 'AI step',
    description:
      'Ask the LLM to produce text from a templated prompt (optionally with an employee persona).',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'text',
        required: true,
        templatable: true,
        placeholder: 'Summarise: {{retrieved}}',
        help: 'The instruction sent to the model.',
      },
      {
        key: 'employeeId',
        label: 'Run as (optional)',
        type: 'employee',
        help: "Uses that AI Employee's persona.",
      },
      {
        key: 'outputKey',
        label: 'Save result as',
        type: 'string',
        required: true,
        default: 'aiText',
        help: 'Later nodes read it with {{<name>}}.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  AI_EMPLOYEE_STEP: {
    type: 'AI_EMPLOYEE_STEP',
    category: 'AI_EMPLOYEE',
    label: 'AI Employee step',
    description:
      'Run a full AI Employee turn (plan, retrieve, memory, act, validate). Every tool call is budget- and approval-gated.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'employeeId',
        label: 'Run as',
        type: 'employee',
        required: true,
        templatable: true,
        help: "The AI Employee whose persona, knowledge, memory and budget apply.",
      },
      {
        key: 'instruction',
        label: 'Instruction',
        type: 'text',
        required: true,
        templatable: true,
        placeholder: 'Score this CV against {{policy}}',
        help: 'What the employee should do this step.',
      },
      {
        key: 'maxToolCalls',
        label: 'Max tool calls',
        type: 'number',
        default: 3,
        help: 'Advisory cap on tool calls this step may make (max 10).',
      },
    ],
    hasSideEffects: true,
    canPauseForApproval: true,
  },

  // ── SKILL ────────────────────────────────────────────────────────────────────
  TOOL_ACTION: {
    type: 'TOOL_ACTION',
    category: 'SKILL',
    label: 'Tool action',
    description:
      'Call one tool on a connected skill (Slack, Gmail, Stripe, HTTP, …) with templated arguments.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'skillKey',
        label: 'Skill',
        type: 'skill',
        required: true,
        help: 'The installed skill to call, e.g. slack, gmail, stripe.',
      },
      {
        key: 'tool',
        label: 'Tool',
        type: 'tool',
        required: true,
        help: 'The action on that skill, e.g. send_message.',
      },
      {
        key: 'args',
        label: 'Arguments',
        type: 'json',
        required: true,
        templatable: true,
        help: 'A JSON object of arguments; each value may use {{templates}}.',
      },
      {
        key: 'employeeId',
        label: 'Run as (optional)',
        type: 'employee',
        help: "Uses that employee's own connection if it has one, otherwise the company-wide one.",
      },
      {
        key: 'outputKey',
        label: 'Save result as',
        type: 'string',
        required: true,
        default: 'toolResult',
        help: 'Later nodes read it with {{<name>}}.',
      },
    ],
    hasSideEffects: true,
    canPauseForApproval: true,
  },

  // ── LOGIC ────────────────────────────────────────────────────────────────────
  WAIT: {
    type: 'WAIT',
    category: 'LOGIC',
    label: 'Wait',
    description: 'Pause for a bounded number of milliseconds (capped by the engine).',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'durationMs',
        label: 'Duration (ms)',
        type: 'duration',
        required: true,
        default: 1000,
        help: 'Milliseconds to wait; capped by the engine (max 10000).',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  CONDITION: {
    type: 'CONDITION',
    category: 'LOGIC',
    label: 'Condition',
    description: 'Compare a templated value against a literal to branch the flow.',
    inputs: 1,
    outputs: CONDITION_OUTPUTS,
    configSchema: [
      {
        key: 'left',
        label: 'Value',
        type: 'string',
        required: true,
        templatable: true,
        help: 'The value to test, usually a {{template}}.',
      },
      {
        key: 'op',
        label: 'Operator',
        type: 'select',
        required: true,
        default: 'eq',
        options: CONDITION_OP_OPTIONS,
      },
      {
        key: 'right',
        label: 'Compare to',
        type: 'string',
        required: true,
        help: 'A literal value to compare against (not templated).',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  SWITCH: {
    type: 'SWITCH',
    category: 'LOGIC',
    label: 'Switch',
    description: 'Branch to a named case based on a templated value.',
    inputs: 1,
    outputs: [],
    dynamicOutputs: 'switch',
    configSchema: [
      {
        key: 'on',
        label: 'Value',
        type: 'string',
        required: true,
        templatable: true,
        help: 'The value matched against the cases.',
      },
      {
        key: 'cases',
        label: 'Cases',
        type: 'json',
        required: true,
        help: 'A list of { value, branch }; each branch needs a matching outgoing edge.',
      },
      {
        key: 'default',
        label: 'Default branch',
        type: 'string',
        help: 'Branch taken when no case matches (optional).',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  PARALLEL: {
    type: 'PARALLEL',
    category: 'LOGIC',
    label: 'Split (parallel)',
    description: 'Fan out to several lanes that converge on a Merge (join) node.',
    inputs: 1,
    outputs: [],
    dynamicOutputs: 'parallel',
    configSchema: [
      {
        key: 'lanes',
        label: 'Lane start nodes',
        type: 'json',
        required: true,
        help: 'A list of node ids, one per lane. Lanes run sequentially.',
      },
      {
        key: 'joinNodeId',
        label: 'Merge node',
        type: 'string',
        required: true,
        help: 'The JOIN node the lanes converge on.',
      },
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'ALL',
        options: MODE_OPTIONS,
        help: 'ALL runs every lane; ANY runs the first lane only.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  JOIN: {
    type: 'JOIN',
    category: 'LOGIC',
    label: 'Merge (join)',
    description:
      'Convergence point for a Split (parallel). Exposes the collected lane outputs to later nodes.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'laneOutputKey',
        label: 'Lane outputs key',
        type: 'string',
        default: '__lanes',
        help: 'Context key the lane outputs are read from.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  LOOP: {
    type: 'LOOP',
    category: 'LOGIC',
    label: 'Loop',
    description:
      'Repeat a body subgraph once per item in an array, up to a bounded number of iterations.',
    inputs: 1,
    outputs: [],
    dynamicOutputs: 'loop',
    configSchema: [
      {
        key: 'over',
        label: 'Array path',
        type: 'expression',
        required: true,
        placeholder: 'shortlisted',
        help: 'A context path resolving to an array (a bare path, not a {{template}}).',
      },
      {
        key: 'body',
        label: 'Body start node',
        type: 'string',
        required: true,
        help: 'The first node id of the loop body.',
      },
      {
        key: 'maxIterations',
        label: 'Max iterations',
        type: 'number',
        required: true,
        default: 100,
        help: 'Hard cap; excess items are skipped with a warning.',
      },
      {
        key: 'itemVar',
        label: 'Item variable',
        type: 'string',
        default: 'item',
        help: 'Name the current item is bound to ({{item}} by default).',
      },
      {
        key: 'done',
        label: 'Continue at (optional)',
        type: 'string',
        help: 'Node id to continue at after the loop finishes.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  TERMINATE: {
    type: 'TERMINATE',
    category: 'LOGIC',
    label: 'Stop',
    description: 'End the run immediately with a chosen outcome. Has no outgoing edges.',
    inputs: 1,
    outputs: [],
    configSchema: [
      {
        key: 'status',
        label: 'Outcome',
        type: 'select',
        default: 'COMPLETED',
        options: TERMINATE_STATUS_OPTIONS,
        help: 'The status the run ends with.',
      },
      {
        key: 'reason',
        label: 'Reason',
        type: 'string',
        templatable: true,
        help: 'Optional human-readable reason recorded on the run.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  // ── APPROVAL ─────────────────────────────────────────────────────────────────
  APPROVAL: {
    type: 'APPROVAL',
    category: 'APPROVAL',
    label: 'Approval',
    description:
      'Pause the run for a manager decision in the Approval Center. Approve resumes; reject fails the run.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'message',
        label: 'Approval message',
        type: 'text',
        templatable: true,
        help: 'Shown to the approver.',
      },
      {
        key: 'autoApprove',
        label: 'Skip approval (auto-approve)',
        type: 'boolean',
        default: false,
        help: 'When on, the step resolves immediately with no pause and no approval request.',
      },
      {
        key: 'routing',
        label: 'Routing rules',
        type: 'json',
        help: 'Optional multi-level sign-off / SLA routing (ApprovalRoutingConfig).',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: true,
  },

  // ── COMMUNICATION ────────────────────────────────────────────────────────────
  NOTIFY: {
    type: 'NOTIFY',
    category: 'COMMUNICATION',
    label: 'Notify',
    description:
      'Email people INSIDE this company. Leave the recipient fields empty and it only records the message in the run log. To message someone outside the company, use a Tool action.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'message',
        label: 'Message',
        type: 'text',
        required: true,
        templatable: true,
        help: 'The message to send (and to record in the run log).',
      },
      {
        key: 'notifyRoles',
        label: 'Notify roles',
        type: 'text',
        required: false,
        templatable: true,
        help: 'Comma-separated: OWNER, ADMIN, MEMBER. Leave empty to send nothing.',
      },
      {
        key: 'notifyUserIds',
        label: 'Notify specific people',
        type: 'text',
        required: false,
        templatable: true,
        help: 'Comma-separated user ids in this company.',
      },
      {
        key: 'notifyDepartmentId',
        label: 'Notify a department',
        type: 'text',
        required: false,
        templatable: true,
        help: 'Everyone active in this department.',
      },
    ],
    // TRUE now, and the change matters: NOTIFY can send email, which cannot be
    // unsent. A dry run must therefore skip it, and the builder must show it as
    // a step that does something to the outside world.
    hasSideEffects: true,
    canPauseForApproval: false,
  },

  // ── VARIABLE ─────────────────────────────────────────────────────────────────
  SET_VARIABLE: {
    type: 'SET_VARIABLE',
    category: 'VARIABLE',
    label: 'Set variable',
    description:
      'Store a value into a writable variable scope (RUNTIME, WORKFLOW or OUTPUT).',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'name',
        label: 'Variable name',
        type: 'string',
        required: true,
        help: 'The variable to write; readable downstream as {{name}}.',
      },
      {
        key: 'value',
        label: 'Value',
        type: 'string',
        templatable: true,
        help: 'The value to store (may use {{templates}}).',
      },
      {
        key: 'scope',
        label: 'Scope',
        type: 'variableScope',
        default: 'RUNTIME',
        options: WRITABLE_SCOPE_OPTIONS,
        help: 'RUNTIME lives for this run; WORKFLOW / OUTPUT persist beyond it.',
      },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        default: 'string',
        options: VARIABLE_TYPE_OPTIONS,
        help: 'How the value is coerced before storing.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  TRANSFORM: {
    type: 'TRANSFORM',
    category: 'VARIABLE',
    label: 'Transform data',
    description: 'Reshape a value with a fixed, safe set of operations (no scripting).',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'input',
        label: 'Input path',
        type: 'expression',
        templatable: true,
        help: 'A context path (or {{template}}) providing the value to transform.',
      },
      {
        key: 'operations',
        label: 'Operations',
        type: 'json',
        help: 'An ordered list of { op, … } steps (jsonPath, map, filter, join, split, toNumber, toString, default).',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  // ── MEMORY ───────────────────────────────────────────────────────────────────
  MEMORY_READ: {
    type: 'MEMORY_READ',
    category: 'MEMORY',
    label: 'Read memory',
    description: "Recall an AI Employee's stored memories into the run context.",
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'employeeId',
        label: 'Employee',
        type: 'employee',
        required: true,
        templatable: true,
        help: 'Whose memory to read.',
      },
      {
        key: 'kind',
        label: 'Kind',
        type: 'select',
        options: MEMORY_KIND_OPTIONS,
        help: 'Filter to FACT or SUMMARY memories (optional).',
      },
      {
        key: 'limit',
        label: 'Max memories',
        type: 'number',
        default: 10,
        help: 'How many to recall (max 50).',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },

  MEMORY_WRITE: {
    type: 'MEMORY_WRITE',
    category: 'MEMORY',
    label: 'Write memory',
    description: "Save a durable fact or summary to an AI Employee's memory.",
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'employeeId',
        label: 'Employee',
        type: 'employee',
        required: true,
        templatable: true,
        help: 'Whose memory to write to.',
      },
      {
        key: 'kind',
        label: 'Kind',
        type: 'select',
        default: 'FACT',
        options: MEMORY_KIND_OPTIONS,
        help: 'Whether this is a FACT or a SUMMARY.',
      },
      {
        key: 'content',
        label: 'Content',
        type: 'text',
        required: true,
        templatable: true,
        help: 'The text to store (may use {{templates}}).',
      },
    ],
    hasSideEffects: true,
    canPauseForApproval: false,
  },

  // ── UTILITY ──────────────────────────────────────────────────────────────────
  NOOP: {
    type: 'NOOP',
    category: 'UTILITY',
    label: 'No-op',
    description:
      'Does nothing. Useful as a placeholder or a merge target while building.',
    inputs: 1,
    outputs: NEXT,
    configSchema: [
      {
        key: 'note',
        label: 'Note',
        type: 'string',
        help: 'An optional author annotation.',
      },
    ],
    hasSideEffects: false,
    canPauseForApproval: false,
  },
};

/**
 * The catalog as a list, in the canonical `NODE_TYPES` order — backs
 * `GET /workflows/node-definitions` (the Workflow Builder palette).
 */
export function listNodeDefinitions(): NodeDefinitionDto[] {
  return NODE_TYPES.map((type) => NODE_CATALOG[type]);
}
