import { Injectable } from '@nestjs/common';
import { SkillCatalog } from '../catalog';
import type {
  ExecutorContext,
  SkillExecutor,
  SkillExecutionResult,
} from './skill-executor';

/**
 * `SKILL_EXECUTOR=auto` dispatcher: per call, route to the REAL executor when the
 * tenant's installed skill is actually usable — i.e. it needs no connection
 * (catalog connection.type === 'none', e.g. the HTTP skill) OR it is CONNECTED
 * with credentials present.
 *
 * Relies on SkillsService having resolved connectionStatus + credentials into
 * `ctx` (this executor sets `usesInstalledCredentials`).
 *
 * ## Phase 1 — `failClosed`
 *
 * When a skill is NOT eligible this used to answer out of the offline MOCK, so
 * "an unconnected skill still returns a (sandbox) result and never 500s". That
 * is the right call in development and exactly the wrong one in production: a
 * customer whose Slack token was revoked overnight would see every workflow
 * keep reporting `ok: true`, and no operator would ever learn the integration
 * had stopped working.
 *
 * In production (`failClosed`) an ineligible call now returns `ok:false` with a
 * reason naming the connection. It is still not a throw — `runTool`'s contract
 * is "never throws for tool-level failures", the SkillExecution audit row is
 * still written, and the workflow engine's normal failure handling applies.
 */
@Injectable()
export class AutoSkillExecutor implements SkillExecutor {
  readonly name = 'auto';
  readonly usesInstalledCredentials = true;

  constructor(
    private readonly real: SkillExecutor,
    private readonly mock: SkillExecutor,
    /** Production: refuse rather than answer an unconnected skill from the sandbox. */
    private readonly failClosed = false,
  ) {}

  execute(
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const connectionType = SkillCatalog.get(skillKey)?.connection.type;
    const credsPresent = Boolean(
      ctx.credentials && Object.keys(ctx.credentials).length > 0,
    );
    const connected = ctx.connectionStatus === 'CONNECTED';
    const eligible =
      connectionType === 'none' || (connected && credsPresent);
    if (eligible) {
      return this.real.execute(skillKey, tool, args, ctx);
    }
    if (this.failClosed) {
      const status = ctx.connectionStatus ?? 'NOT_CONNECTED';
      return Promise.resolve({
        ok: false,
        error:
          `${skillKey} is not connected (status: ${status}${credsPresent ? '' : ', no stored credentials'}), ` +
          `so ${skillKey}.${tool} was not executed. Reconnect the skill in Settings → Skills. ` +
          'Refusing to return a simulated result in production.',
      });
    }
    return this.mock.execute(skillKey, tool, args, ctx);
  }
}
