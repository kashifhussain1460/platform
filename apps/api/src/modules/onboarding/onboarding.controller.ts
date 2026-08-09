import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import type {
  CompleteOnboardingResultDto,
  EmployeeRoleTemplate,
  OnboardingStatusDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import {
  SaveAiEmployeesDto,
  SaveCompanyDto,
  SaveGoalsDto,
} from './dto/onboarding-steps.dto';
import { OnboardingService } from './onboarding.service';

/**
 * AI Onboarding Wizard routes, tenant-scoped by companyId from the JWT.
 * Reads are open to any authenticated member; completing onboarding hires AI
 * employees (which consume plan seats) and rewrites the company profile, so it
 * is OWNER/ADMIN like every other company-level mutation.
 */
@Controller('onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('status')
  status(@CurrentTenant() companyId: string): Promise<OnboardingStatusDto> {
    return this.onboarding.status(companyId);
  }

  @Get('catalog')
  catalog(): EmployeeRoleTemplate[] {
    return this.onboarding.catalog();
  }

  /** Step 1 — save the company profile (resumable). */
  @Patch('company')
  @Roles('OWNER', 'ADMIN')
  saveCompany(
    @CurrentTenant() companyId: string,
    @Body() dto: SaveCompanyDto,
  ): Promise<OnboardingStatusDto> {
    return this.onboarding.saveCompany(companyId, dto);
  }

  /** Step 2 — select AI Employees (reconciles goals). */
  @Patch('ai-employees')
  @Roles('OWNER', 'ADMIN')
  saveAiEmployees(
    @CurrentTenant() companyId: string,
    @Body() dto: SaveAiEmployeesDto,
  ): Promise<OnboardingStatusDto> {
    return this.onboarding.saveAiEmployees(companyId, dto.roles);
  }

  /** Step 3 — pick business goals (filtered to the selected roles). */
  @Patch('goals')
  @Roles('OWNER', 'ADMIN')
  saveGoals(
    @CurrentTenant() companyId: string,
    @Body() dto: SaveGoalsDto,
  ): Promise<OnboardingStatusDto> {
    return this.onboarding.saveGoals(companyId, dto.goals);
  }

  @Post('complete')
  @Roles('OWNER', 'ADMIN')
  complete(
    @CurrentTenant() companyId: string,
    @Body() dto: CompleteOnboardingDto,
  ): Promise<CompleteOnboardingResultDto> {
    return this.onboarding.complete(companyId, dto);
  }
}
