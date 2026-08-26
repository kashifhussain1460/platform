import { Controller, Get, UseGuards } from '@nestjs/common';
import type { DashboardCompositionDto, ProductContextDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardComposerService } from './dashboard-composer.service';
import { ProductContextService } from './product-context.service';

/**
 * `GET /product-context` — the single resolved answer to "what is relevant and
 * available for this company, department, user and hired AI Employees?".
 *
 * ## Why one endpoint
 *
 * Before this, every page derived its own answer. Three separate frontend files
 * carried `plan === 'BUSINESS' || plan === 'ENTERPRISE'`, the sidebar carried
 * four static arrays and forgot the plan rule entirely, and nothing anywhere
 * consulted the company's industry, goals or departments. One endpoint means
 * one place to be right — and one place to fix when the rule changes.
 *
 * ## It shows, it does not enforce
 *
 * The payload is already narrowed by relevance ∧ entitlement ∧ authorization,
 * but it is a VIEW. Every endpoint a caller navigates to keeps its own guard;
 * absence from this payload must never be the only thing standing between a
 * user and a resource. Treating a UI hint as a security control is how a
 * hidden button becomes a vulnerability.
 *
 * Any authenticated member may read it: it describes their own tenant, scoped
 * to what they personally may see.
 */
@Controller('product-context')
@UseGuards(JwtAuthGuard)
export class ProductContextController {
  constructor(
    private readonly productContext: ProductContextService,
    private readonly dashboardComposer: DashboardComposerService,
  ) {}

  @Get()
  resolve(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProductContextDto> {
    return this.productContext.resolve(companyId, {
      userId: user.userId,
      role: user.role,
    });
  }

  /**
   * The dashboard, composed from the SAME resolved capabilities as the
   * navigation.
   *
   * Separate from `GET /product-context` because it is materially more
   * expensive — it runs domain aggregates across HR, Marketing and Support —
   * and the shell fetches the context on every page while only one page needs
   * these numbers.
   */
  @Get('dashboard')
  dashboard(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DashboardCompositionDto> {
    return this.dashboardComposer.compose(companyId, {
      userId: user.userId,
      role: user.role,
    });
  }
}
