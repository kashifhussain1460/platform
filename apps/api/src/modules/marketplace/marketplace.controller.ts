import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { AiEmployeeDto, MarketplaceCatalogDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { InstallEmployeeDto } from './dto/install-employee.dto';
import { MarketplaceService } from './marketplace.service';

/**
 * Marketplace routes: tenant-scoped by companyId (from the JWT), JWT-guarded.
 * The catalog is code-defined; installs delegate to the existing services.
 * (Skill installs stay at the existing POST /skills/install.)
 *
 * ## Phase 4 — workflow templates were REMOVED from here
 *
 * Two systems installed workflow templates: this code catalog (3 templates,
 * delegate-to-create) and the DB-backed `WorkflowTemplate` model (22
 * first-party, at `/workflow-templates`). The DB model is the authoritative
 * doc-19 path and is better on every axis that matters — versioning,
 * provenance, `Idempotency-Key` dedup, prerequisite checking with a 422, and
 * validation against the frozen node vocabulary. This layer had none of it.
 *
 * The three retired templates used `AI_STEP` and `NOTIFY`, which doc 27 §0.4
 * bans and the DB catalog's boot-time `validateManifest` rejects, so they
 * could not be ported without rewriting their graphs — deliberately out of
 * scope here rather than done hastily. `MARKETPLACE_RETIRED_WORKFLOWS` records
 * exactly what was dropped.
 *
 * EMPLOYEE templates stay: they are not duplicated anywhere.
 *
 * ## Authorization: hiring here is the SAME privilege as hiring anywhere else
 *
 * This controller used to carry `@UseGuards(JwtAuthGuard)` alone, with no
 * permission decorator on the install route — so any authenticated MEMBER could
 * hire an AI Employee from a template, while the canonical `POST /employees`
 * required the `employee:manage` capability (floor ADMIN). Hiring consumes a
 * plan seat and stamps a monthly credit budget, so that was a privilege gap on
 * a surface that spends the company's money.
 *
 * Browsing the catalog stays open to any member; installing does not. Pinned by
 * `marketplace.e2e-spec.ts` — a MEMBER must get 403 from install and 200 from
 * the catalog.
 */
@Controller('marketplace')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  /** The catalog: hireable employee templates + the reused skills catalog. */
  @Get()
  catalog(): MarketplaceCatalogDto {
    return this.marketplace.catalog();
  }

  /** Hire an AI employee from a template (optional name override). */
  @Post('employees/:key/install')
  @RequirePermission('employee:manage')
  installEmployee(
    @CurrentTenant() companyId: string,
    @Param('key') key: string,
    @Body() dto: InstallEmployeeDto,
  ): Promise<AiEmployeeDto> {
    return this.marketplace.installEmployee(companyId, key, dto);
  }

}
