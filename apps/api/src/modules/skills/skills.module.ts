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

/**
 * Pick the skill-execution backend from SKILL_EXECUTOR (mirrors the embeddings /
 * llm factories):
 *   - `mock` (DEFAULT): offline, deterministic, side-effect-free sandbox.
 *   - `real`: RealSkillExecutor — real network calls (slack/http/gmail/calendar/
 *     gdrive/scheduling) using the tenant's decrypted credentials; falls back to
 *     mock when a call is unimplemented or has no credentials.
 *   - `auto`: per call, use `real` when the installed skill is connected-with-creds
 *     (or needs no connection), else `mock`.
 * The mock stays the default so the e2e suite runs fully offline and unchanged.
 */
function skillExecutorFactory(
  config: ConfigService,
  scheduling: SchedulingService,
  postizClient: PostizClientService,
  prisma: PrismaService,
  chatwootClient: ChatwootClientService,
  crypto: CryptoService,
  planeClient: PlaneClientService,
): SkillExecutor {
  const kind = (config.get<string>('SKILL_EXECUTOR') ?? 'mock').toLowerCase();
  const mock = new MockSkillExecutor();
  switch (kind) {
    case 'real':
      return new RealSkillExecutor(config, mock, scheduling, postizClient, prisma, chatwootClient, crypto, planeClient);
    case 'auto':
      return new AutoSkillExecutor(
        new RealSkillExecutor(config, mock, scheduling, postizClient, prisma, chatwootClient, crypto, planeClient),
        mock,
      );
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
