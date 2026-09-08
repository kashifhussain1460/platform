import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * Top-level module, NOT nested under `modules/engines/whatsapp`: `Lead` is a
 * shared entity per the design (a `source` enum tells you which channel
 * captured it), so its human-facing CRUD surface does not belong to one
 * channel's engine module — mirrors `MarketingWorkspaceModule` sitting
 * alongside (not inside) `modules/engines/marketing`.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
