import type { ToolDefinitionDto } from '@vaep/types';
import type { LlmCompletionInput, LlmCompletionResult } from './llm.provider';

/**
 * Deterministic offline script for the Orlixa AI Assist agent loop.
 *
 * The agent is a multi-step tool loop, so testing it needs a provider that
 * behaves like one — a single canned answer proves nothing. This walks the real
 * shape a build takes:
 *
 *   1. `list_employees`  — look at who works here
 *   2. `list_skills`     — look at what's connected
 *   3. `propose_graph`   — save a valid frozen-17 graph grounded in 1 + 2
 *   4. `finish`          — summarise
 *
 * Which step it's on is derived from the tool results already in the transcript,
 * so it is stateless and reproducible: the same messages always give the same
 * next call. No wall clock, no randomness.
 *
 * ⚠️ This is a TEST DOUBLE, not a fallback. It runs only under
 * `LLM_PROVIDER=mock`, which `requireRealProviderInProduction` refuses in prod.
 */

/** Tool names whose results we count to decide where we are in the script. */
const STEPS = [
  'list_employees',
  'list_skills',
  'propose_graph',
  'dry_run_test',
  'finish',
] as const;

interface SeenState {
  called: Set<string>;
  employeeId: string | null;
  skillKey: string | null;
  skillTool: string | null;
  /** True when a propose_graph came back rejected — retry differently. */
  proposeRejected: boolean;
}

export function completeAssistTurn(
  input: LlmCompletionInput,
  tools?: ToolDefinitionDto[],
): LlmCompletionResult {
  const available = new Set((tools ?? []).map((t) => t.name));
  const seen = readTranscript(input);

  // 1 + 2 — gather grounding, in a fixed order.
  for (const step of ['list_employees', 'list_skills'] as const) {
    if (available.has(step) && !seen.called.has(step)) {
      return toolCall(step, {});
    }
  }

  // 3 — propose. Only once; a rejection means we fall through to answering
  // rather than looping forever on the same bad graph.
  if (
    available.has('propose_graph') &&
    !seen.called.has('propose_graph') &&
    !seen.proposeRejected
  ) {
    return toolCall('propose_graph', {
      definition: JSON.stringify(buildGraph(seen)),
      rationale:
        'A trigger starts it, the employee does the thinking, a human approves, then the action goes out.',
    });
  }

  // 4 — test what was built. Skipped if the propose was rejected, since there
  // would be nothing new to test.
  if (
    available.has('dry_run_test') &&
    seen.called.has('propose_graph') &&
    !seen.proposeRejected &&
    !seen.called.has('dry_run_test')
  ) {
    return toolCall('dry_run_test', {
      sampleTrigger: JSON.stringify({ candidate: 'Priya', email: 'priya@example.com' }),
    });
  }

  // 5 — wrap up.
  if (available.has('finish') && !seen.called.has('finish')) {
    return toolCall('finish', {
      summary: seen.employeeId
        ? 'Built and tested it: your AI employee handles the work, a person approves, then the message goes out. The test run passed and the send was simulated — nothing was really sent.'
        : 'Built the shape of it. You have no AI employees hired yet, so that step needs someone assigned before it can run.',
    });
  }

  return {
    content:
      "That's saved. Tell me what you'd like to change and I'll adjust it.",
  };
}

/**
 * Reconstruct progress from the transcript. Tool RESULTS are `role:'tool'`
 * messages (native threading), with the older text-marker form not used here.
 */
function readTranscript(input: LlmCompletionInput): SeenState {
  const state: SeenState = {
    called: new Set(),
    employeeId: null,
    skillKey: null,
    skillTool: null,
    proposeRejected: false,
  };

  for (const m of input.messages) {
    if (m.role === 'assistant' && m.toolCall) {
      state.called.add(m.toolCall.tool);
      continue;
    }
    if (m.role !== 'tool') continue;

    const name = m.toolName ?? '';
    state.called.add(name);

    const parsed = safeParse(m.content);
    if (!parsed) continue;

    if (name === 'list_employees') {
      const first = firstOf(parsed, 'employees');
      state.employeeId = strProp(first, 'id');
    }
    if (name === 'list_skills') {
      const skill = firstOf(parsed, 'skills');
      state.skillKey = strProp(skill, 'skillKey');
      const tool = firstOf(skill, 'tools');
      state.skillTool = strProp(tool, 'tool');
    }
    if (name === 'propose_graph' && parsed.saved !== true) {
      state.proposeRejected = true;
    }
  }
  return state;
}

/**
 * A small, VALID frozen-17 graph, adapted to what the tenant actually has:
 * TRIGGER → AI_EMPLOYEE_STEP → APPROVAL → TOOL_ACTION, dropping the steps whose
 * dependencies are missing. Deliberately uses AI_EMPLOYEE_STEP and TOOL_ACTION —
 * never the retired AI_STEP/NOTIFY — so the offline path exercises the same
 * vocabulary the real one must (G32).
 */
function buildGraph(seen: SeenState): {
  nodes: unknown[];
  edges: unknown[];
} {
  const nodes: Record<string, unknown>[] = [
    { id: 'trigger', type: 'TRIGGER', name: 'When this starts', config: {} },
  ];
  const edges: Record<string, unknown>[] = [];
  let previous = 'trigger';

  if (seen.employeeId) {
    nodes.push({
      id: 'think',
      type: 'AI_EMPLOYEE_STEP',
      name: 'Do the work',
      config: {
        employeeId: seen.employeeId,
        instruction: 'Handle the incoming request and draft what should happen next.',
        outputKey: 'draft',
      },
    });
    edges.push({ from: previous, to: 'think' });
    previous = 'think';
  }

  if (seen.skillKey && seen.skillTool) {
    nodes.push({
      id: 'approve',
      type: 'APPROVAL',
      name: 'Get a person to approve',
      config: { message: 'Please review this before it goes out.' },
    });
    edges.push({ from: previous, to: 'approve' });

    nodes.push({
      id: 'send',
      type: 'TOOL_ACTION',
      name: 'Send it',
      config: {
        skillKey: seen.skillKey,
        tool: seen.skillTool,
        args: {},
        outputKey: 'sent',
      },
    });
    edges.push({ from: 'approve', to: 'send' });
  } else if (previous === 'trigger') {
    // Nothing to ground on at all — still produce a structurally valid graph so
    // the caller gets a real draft rather than an error.
    nodes.push({ id: 'noop', type: 'NOOP', name: 'Placeholder step', config: {} });
    edges.push({ from: 'trigger', to: 'noop' });
  }

  return { nodes, edges };
}

function toolCall(
  tool: string,
  args: Record<string, unknown>,
): LlmCompletionResult {
  return {
    toolCall: {
      skillKey: '',
      tool,
      args,
      // A stable synthetic id per tool: the loop threads results by callId, and
      // a fixed value keeps transcripts byte-identical across runs.
      callId: `mock-${tool}`,
    },
  };
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstOf(
  obj: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const arr = obj?.[key];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0] as unknown;
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

function strProp(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === 'string' && v ? v : null;
}

export const MOCK_ASSIST_STEPS = STEPS;
