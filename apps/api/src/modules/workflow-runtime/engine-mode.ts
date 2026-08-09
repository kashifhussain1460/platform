import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type EngineMode = 'legacy_walk' | 'state_machine';

/**
 * P1-07 — the cutover flag (doc 16 §29, doc 25 §7).
 *
 * The durable state machine replaces the execution path for live customer
 * automation, so it ships behind a per-company flag with the legacy walk as the
 * fallback. Rollback is flipping the flag — not a deploy. That is the whole
 * point: a rollback that requires shipping code is not a rollback when you are
 * mid-incident.
 *
 * Configuration (most specific wins):
 *   WORKFLOW_ENGINE_MODE            global default, defaults to `legacy_walk`
 *   WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES   comma-separated company ids
 *
 * Default is `legacy_walk` deliberately: shipping this code must change nothing
 * until a specific tenant is opted in.
 */
@Injectable()
export class EngineModeService {
  private readonly logger = new Logger(EngineModeService.name);
  private readonly globalMode: EngineMode;
  private readonly optedIn: ReadonlySet<string>;

  constructor(config: ConfigService) {
    const raw = (config.get<string>('WORKFLOW_ENGINE_MODE') ?? '').trim();
    this.globalMode = raw === 'state_machine' ? 'state_machine' : 'legacy_walk';

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
  }

  modeFor(companyId: string): EngineMode {
    if (this.optedIn.has(companyId)) return 'state_machine';
    return this.globalMode;
  }

  usesStateMachine(companyId: string): boolean {
    return this.modeFor(companyId) === 'state_machine';
  }
}
