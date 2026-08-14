import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { TeamDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { OrganizationService } from './organization.service';

/**
 * Teams (P1 #7), tenant-scoped by companyId from the JWT. Reading is open to any
 * authenticated member; mutations require `organization:manage`, whose ADMIN
 * floor is exactly the `@Roles('OWNER','ADMIN')` it replaces. A team may
 * optionally belong to a department (validated to be in the same tenant).
 */
@Controller('teams')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class TeamsController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  list(@CurrentTenant() companyId: string): Promise<TeamDto[]> {
    return this.org.listTeams(companyId);
  }

  @Post()
  @RequirePermission('organization:manage')
  create(
    @CurrentTenant() companyId: string,
    @Body() dto: CreateTeamDto,
  ): Promise<TeamDto> {
    return this.org.createTeam(companyId, dto);
  }

  @Patch(':id')
  @RequirePermission('organization:manage')
  update(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTeamDto,
  ): Promise<TeamDto> {
    return this.org.updateTeam(companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('organization:manage')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.org.removeTeam(companyId, id);
  }
}
