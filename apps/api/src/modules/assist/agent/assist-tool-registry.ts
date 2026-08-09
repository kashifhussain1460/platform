import { z } from 'zod';
import type { ToolDefinitionDto, ToolParametersDto } from '@vaep/types';

/**
 * The assist agent's tool contract.
 *
 * Two constraints shape this file:
 *
 * 1. **`ToolParametersDto` is deliberately SHALLOW** — one level of properties,
 *    primitive types only (doc 00 §0.7). So a tool that needs structured input
 *    (a whole workflow graph) takes it as a JSON **string** and parses it
 *    server-side. That is a real limitation of the shared contract, not an
 *    oversight, and widening it would ripple into every skill definition.
 *
 * 2. **Args are validated with zod before the tool runs.** A malformed call is
 *    fed back to the model as a tool RESULT describing the problem, never thrown
 *    — self-correction is the cheapest correction loop we have, and an exception
 *    would kill a turn the model could have fixed itself.
 */

/** Outcome of running a tool. `ok:false` is normal and goes back to the model. */
export interface AssistToolOutcome {
  ok: boolean;
  /** Serialised back to the model as the tool result. */
  result: unknown;
  /** One-line human summary for the UI trace ("Read 11 installed skills"). */
  summary: string;
  /** True for a tool that hands control back to the user, ending the turn. */
  terminal?: boolean;
}

/** Everything a tool may touch. `companyId` comes from the request, never args. */
export interface AssistToolContext {
  companyId: string;
  userId: string;
  sessionId: string;
}

export interface AssistTool<TArgs = unknown> {
  name: string;
  /** Shown to the model — this is prompt surface, so it must earn its tokens. */
  description: string;
  schema: z.ZodType<TArgs>;
  /** Flat JSON-schema projection for the provider. */
  parameters: ToolParametersDto;
  /** Ends the turn and returns control to the user (ask_user, finish, …). */
  terminal?: boolean;
  run(ctx: AssistToolContext, args: TArgs): Promise<AssistToolOutcome>;
}

/**
 * A registry of tools, exposing exactly two things to the agent loop: the
 * provider-facing definitions, and a validated dispatch.
 */
export class AssistToolRegistry {
  private readonly byName = new Map<string, AssistTool<never>>();

  constructor(tools: AssistTool<never>[]) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  /** What we hand the LLM as its available tools. */
  definitions(): ToolDefinitionDto[] {
    return [...this.byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  isTerminal(name: string): boolean {
    return this.byName.get(name)?.terminal === true;
  }

  /**
   * Validate then run. Every failure path returns an outcome rather than
   * throwing, so one bad tool call degrades into a correction instead of
   * aborting the user's turn.
   */
  async dispatch(
    ctx: AssistToolContext,
    name: string,
    rawArgs: Record<string, unknown>,
  ): Promise<AssistToolOutcome> {
    const tool = this.byName.get(name);
    if (!tool) {
      return {
        ok: false,
        summary: `Unknown tool "${name}"`,
        result: {
          error: `There is no tool called "${name}". Available tools: ${[...this.byName.keys()].join(', ')}.`,
        },
      };
    }

    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        summary: `Invalid arguments for ${name}`,
        result: {
          error: `Your arguments for "${name}" were not valid: ${formatZodError(parsed.error)}. Fix them and call it again.`,
        },
      };
    }

    try {
      return await (tool as AssistTool<unknown>).run(ctx, parsed.data);
    } catch (err) {
      // A tool blowing up is a bug, but the turn should still be recoverable —
      // report it to the model and let it try something else.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `${name} failed`,
        result: { error: `The tool "${name}" failed: ${message}` },
      };
    }
  }
}

/** Compact, model-readable rendering of a zod failure. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

// ── Helpers for declaring the flat parameter schemas ─────────────────────────

type Prop = { type: string; description?: string; enum?: string[] };

export function params(
  properties: Record<string, Prop>,
  required: string[] = [],
): ToolParametersDto {
  return { type: 'object', properties, required };
}

export const noParams = (): ToolParametersDto => params({}, []);
