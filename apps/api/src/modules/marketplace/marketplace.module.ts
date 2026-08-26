import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { SkillsModule } from '../skills/skills.module';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

/**
 * Marketplace (Step 14): a code-defined catalog to hire more AI Employees,
 * plus the reused Skills catalog. A LEAF module — it imports Employees and
 * Skills and none of them import it, so there is no dependency cycle. No new
 * Prisma models: installs delegate to the existing services.
 *
 * The `WorkflowsModule` edge went away with the workflow templates in Phase 4
 * §4; `/workflow-templates` is now the one authoritative template system.
 */
@Module({
  imports: [EmployeesModule, SkillsModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
})
export class MarketplaceModule {}
