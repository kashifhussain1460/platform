import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isInlineExecution } from '../../common/resilience/workflow-execution-mode';

export type EngineMode = 'legacy_walk' | 'state_machine';

/**
 * P1-07 — the engine selector (doc 16 §29, doc 25 §7).
 *
 * **The durable state machine is THE engine.** It ships on by default; the
 * legacy walk is the opt-out, kept only as a mid-incident escape hatch. That
 * ordering is deliberate and was changed in WAVE 9: while the default was
 * `legacy_walk`, the durable runtime — attempts, leases, reaper recovery,
 * exactly-once side effects — was real, tested code that **no run anywhere ever
 * reached**. A safety feature that is off by default is a feature nobody has.
 *
 * Rollback is still flipping a flag, not shipping a deploy: set
 * `WORKFLOW_ENGINE_MODE=legacy_walk`. A rollback that requires a release is not
 * a rollback when you are mid-incident.
 *
 * Configuration (most specific wins):
 *   WORKFLOW_ENGINE_MODE                     `state_machine` (default) | `legacy_walk`
 *   WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES  comma-separated ids — forces the
 *                                            durable engine for those tenants
 *                                            even when the global default is
 *                                            `legacy_walk` (staged rollout, and
 *                                            the way back in after a rollback)
 */
@Injectable()
export class EngineModeService {
  private readonly logger = new Logger(EngineModeService.name);
  private readonly globalMode: EngineMode;
  private readonly optedIn: ReadonlySet<string>;

  constructor(config: ConfigService) {
    const raw = (config.get<string>('WORKFLOW_ENGINE_MODE') ?? '').trim();
    // Opt OUT, not opt in: anything other than an explicit `legacy_walk` gets
    // the durable engine. A typo therefore lands on the SAFE engine rather than
    // silently dropping a deployment back to the one with no recovery.
    this.globalMode = raw === 'legacy_walk' ? 'legacy_walk' : 'state_machine';

    const list = config.get<string>(
      'WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES',
    );
    this.optedIn = new Set(
      (list ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    this.logger.log(
      `workflow engine mode: default=${this.globalMode} opted-in-companies=${this.optedIn.size}`,
    );

    // The trap this exists to close: `inline` execution silently degrades every
    // run to the legacy walker (see `modeFor`). Someone who set
    // WORKFLOW_ENGINE_MODE=state_machine would believe they had durable
    // execution — attempts, leases, automatic recovery — and have none of it,
    // with nothing anywhere saying so. Now it says so, loudly, at boot.
    if (isInlineExecution() && this.globalMode === 'state_machine') {
      this.logger.error(
        'DURABLE ENGINE IS NOT ACTIVE: WORKFLOW_EXECUTION_MODE=inline forces every ' +
          'run onto the legacy walker, because inline has no worker to consume the ' +
          'advance/attempt jobs the durable runtime is built from. There are NO ' +
          'durable attempts, NO leases and NO automatic recovery in this process. ' +
          'To get the durable engine: run an always-on worker with ' +
          'QUEUE_WORKERS_ENABLED and set WORKFLOW_EXECUTION_MODE=queue ' +
          '(see docs/ops/durable-engine-rollout.md).',
      );
    }
  }

  modeFor(companyId: string): EngineMode {
    // WAVE 1: the durable runtime is queue-driven BY CONSTRUCTION — a decision
    // (advance) and an effect (attempt) are separate jobs precisely so a retry
    // of the decision cannot re-run the effect. `inline` mode exists for the
    // serverless deployment, which has no worker at all: an advance job would be
    // created and never consumed, so every run would stop after zero nodes.
    //
    // Degrading here rather than at the call site means an inline deployment
    // keeps WORKING (on the legacy walker) instead of silently doing nothing.
    // The constructor shouts about it so the degradation is never a surprise.
    if (isInlineExecution()) return 'legacy_walk';
    if (this.optedIn.has(companyId)) return 'state_machine';
    return this.globalMode;
  }

  usesStateMachine(companyId: string): boolean {
    return this.modeFor(companyId) === 'state_machine';
  }

  /**
   * Whether the durable engine is genuinely in force in THIS process.
   *
   * Exposed so health/status surfaces can report the truth rather than the
   * intent — the whole B1 finding was that configuration said one thing and
   * execution did another.
   */
  isDurableActive(): boolean {
    return !isInlineExecution() && this.globalMode === 'state_machine';
  }
}
