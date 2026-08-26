import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmployeeSkillsController } from './employee-skills.controller';
import {
  SKILL_EXECUTOR_TOKEN,
  type SkillExecutor,
} from './executors/skill-executor';
import { MockSkillExecutor } from './executors/mock-skill-executor';
import { RealSkillExecutor } from './executors/real-skill-executor';
import { AutoSkillExecutor } from './executors/auto-skill-executor';
import { ConnectorHealthService } from './connectors/connector-health.service';
import { ConnectorHealthProcessor } from './connectors/connector-health.processor';
import {
  CONNECTOR_FETCH,
  ConnectorTokenService,
  type FetchLike,
} from './connectors/connector-token.service';
import { CONNECTOR_HEALTH_QUEUE } from './connectors/connector.constants';
import { ConnectorsController } from './connectors/connectors.controller';
import { SkillsOAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';
import { SkillRequirementsService } from './skill-requirements.service';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PostizClientService } from '../engines/marketing/postiz-client.service';
import { MarketingModule } from '../engines/marketing/marketing.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChatwootClientService } from '../engines/support/chatwoot-client.service';
import { SupportModule } from '../engines/support/support.module';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PlaneClientService } from '../engines/pm/plane-client.service';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { ToolIdempotencyService } from '../../common/idempotency/tool-idempotency.service';
import { SuppressionService } from '../engines/marketing/suppression.service';
import { CreditsModule } from '../credits/credits.module';
import { requireRealProviderInProduction } from '../../common/config/require-real-provider';

/**
 * Pick the skill-execution backend from SKILL_EXECUTOR (mirrors the embeddings /
 * llm factories):
 *   - `mock` (DEFAULT): offline, deterministic, side-effect-free sandbox.
 *   - `real`: RealSkillExecutor — real network calls (slack/http/gmail/calendar/
 *     gdrive/scheduling) using the tenant's decrypted credentials.
 *   - `auto`: per call, use `real` when the installed skill is connected-with-creds
 *     (or needs no connection), else `mock`.
 * The mock stays the default so the e2e suite runs fully offline and unchanged.
 *
 * ## Phase 1 — two ways this used to lie, both closed here
 *
 * 1. **Silent mock in production.** `requireRealProviderInProduction` already
 *    guarded LLM_PROVIDER, BILLING_PROVIDER and MAIL_ENABLED. SKILL_EXECUTOR
 *    was the one provider factory without it, so `NODE_ENV=production` with the
 *    variable simply unset booted happily and answered every integration call
 *    with a fabricated success. Now it refuses to start.
 *
 * 2. **Unknown value → mock.** The old `default:` branch swallowed typos:
 *    `SKILL_EXECUTOR=REAL_` or `SKILL_EXECUTOR=production` silently selected the
 *    sandbox. An unrecognised value is now a boot error in every environment —
 *    a config typo must never be indistinguishable from "I chose the mock".
 *
 * `failClosed` (production) additionally stops the two PER-CALL fallbacks to
 * mock inside `auto` and `real`. Guarding only the factory would have been
 * cosmetic: `SKILL_EXECUTOR=auto` in production still answered every
 * unconnected skill, and every unimplemented tool, out of the sandbox.
 */
const KNOWN_SKILL_EXECUTORS = ['mock', 'real', 'auto'] as const;

export function skillExecutorFactory(
  config: ConfigService,
  scheduling: SchedulingService,
  postizClient: PostizClientService,
  prisma: PrismaService,
  chatwootClient: ChatwootClientService,
  crypto: CryptoService,
  planeClient: PlaneClientService,
  idempotency: ToolIdempotencyService,
  suppression: SuppressionService,
): SkillExecutor {
  const raw = (config.get<string>('SKILL_EXECUTOR') ?? 'mock').trim().toLowerCase();
  if (!(KNOWN_SKILL_EXECUTORS as readonly string[]).includes(raw)) {
    throw new Error(
      `SKILL_EXECUTOR="${raw}" is not a recognized skill executor. ` +
        `Expected one of: ${KNOWN_SKILL_EXECUTORS.join(', ')}. ` +
        'Refusing to start rather than silently falling back to the offline mock.',
    );
  }
  const kind = raw as (typeof KNOWN_SKILL_EXECUTORS)[number];
  requireRealProviderInProduction('SKILL_EXECUTOR', kind);

  const failClosed = process.env.NODE_ENV === 'production';
  const mock = new MockSkillExecutor();
  const makeReal = (): RealSkillExecutor =>
    new RealSkillExecutor(config, mock, scheduling, postizClient, prisma, chatwootClient, crypto, planeClient, idempotency, suppression, failClosed);

  switch (kind) {
    case 'real':
      return makeReal();
    case 'auto':
      return new AutoSkillExecutor(makeReal(), mock, failClosed);
    case 'mock':
    default:
      return mock;
  }
}

/**
 * Skills module: the built-in catalog (code), tenant-scoped install/assign, the
 * runtime seam (getToolsForEmployee / runTool), the OAuth authorize/callback
 * endpoints, and the CONNECTOR lifecycle (Unit B): ConnectorHealthService (state
 * machine + passive/active health), ConnectorTokenService (single-flight OAuth
 * refresh), the scheduled `connector-health` sweep (BullMQ repeatable), and the
 * connector health endpoints. Exports SkillsService (runtime tool execution) and
 * ConnectorHealthService. The shared BullMQ connection is registered globally by
 * KnowledgeModule, so only registerQueue is needed here.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: CONNECTOR_HEALTH_QUEUE }),
    SchedulingModule,
    MarketingModule,
    SupportModule,
    CreditsModule,
  ],
  controllers: [
    SkillsController,
    EmployeeSkillsController,
    SkillsOAuthController,
    ConnectorsController,
  ],
  providers: [
    SkillsService,
    SkillRequirementsService,
    OAuthService,
    ConnectorHealthService,
    ConnectorTokenService,
    ...(queueWorkersEnabled() ? [ConnectorHealthProcessor] : []),
    // Temporary direct provider: PmModule doesn't exist yet (Task 5), same
    // reasoning as PostizClientService/ChatwootClientService above.
    PlaneClientService,
    ToolIdempotencyService,
    {
      provide: SKILL_EXECUTOR_TOKEN,
      inject: [
        ConfigService,
        SchedulingService,
        PostizClientService,
        PrismaService,
        ChatwootClientService,
        CryptoService,
        PlaneClientService,
        ToolIdempotencyService,
        SuppressionService,
      ],
      useFactory: skillExecutorFactory,
    },
    // Injectable fetch for the token-refresh endpoint call (stubbed in unit tests).
    {
      provide: CONNECTOR_FETCH,
      useValue: ((url, init) => fetch(url, init)) as FetchLike,
    },
  ],
  exports: [
    SkillsService,
    SkillRequirementsService,
    ConnectorHealthService,
    ConnectorTokenService,
  ],
})
export class SkillsModule {}
