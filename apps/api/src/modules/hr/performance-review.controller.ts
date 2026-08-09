import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PerformanceReviewDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import {
  CreatePerformanceReviewDto,
  UpdatePerformanceReviewDto,
} from './dto/performance-review.dto';
import { PerformanceReviewService } from './performance-review.service';

/** Performance reviews (P3-01). AI draft + final text are sensitive. OWNER/ADMIN only. */
@Controller('hr/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class PerformanceReviewController {
  constructor(private readonly reviews: PerformanceReviewService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('staffId') staffId?: string,
  ): Promise<PerformanceReviewDto[]> {
    return this.reviews.list(companyId, staffId);
  }

  @Post()
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePerformanceReviewDto,
  ): Promise<PerformanceReviewDto> {
    return this.reviews.create(companyId, dto, user.userId);
  }

  @Patch(':id')
  update(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePerformanceReviewDto,
  ): Promise<PerformanceReviewDto> {
    return this.reviews.update(companyId, id, dto, user.userId);
  }
}
