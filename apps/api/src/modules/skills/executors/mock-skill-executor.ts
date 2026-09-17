import { Injectable } from '@nestjs/common';
import { SkillCatalog } from '../catalog';
import type {
  ExecutorContext,
  SkillExecutor,
  SkillExecutionResult,
} from './skill-executor';

/** Small, stable hash of a string → short hex, for deterministic mock ids. */
function shortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * DEFAULT executor: fully offline, side-effect-free and DETERMINISTIC. Every
 * tool returns a sandbox result of the shape
 *   { id: 'mock_<tool>_<hash>', skillKey, tool, echoed: <args>, sandbox: true }
 * so the runtime, tests and UI can assert on it without any network access. The
 * HTTP skill in particular NEVER makes a real request here.
 *
 * TODO: real per-skill executors (lazy, credential-backed) — e.g. a
 * SlackExecutor / StripeExecutor selected by skillKey, with the InstalledSkill's
 * (encrypted) `config` supplying credentials. Kept as a single mock for now.
 */
@Injectable()
export class MockSkillExecutor implements SkillExecutor {
  readonly name = 'mock';

  async execute(
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
    _ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    if (!SkillCatalog.getTool(skillKey, tool)) {
      return { ok: false, error: `Unknown skill/tool: ${skillKey}/${tool}` };
    }
    const id = `mock_${tool}_${shortHash(`${skillKey}:${tool}:${JSON.stringify(args)}`)}`;
    return {
      ok: true,
      result: { id, skillKey, tool, echoed: args, sandbox: true },
      simulated: true,
    };
  }
}
