import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { HrRetentionResultDto } from '@vaep/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { HrRetentionService } from './hr-retention.service';

/**
 * Operability endpoint to run the HR data-retention sweep on demand (the daily
 * repeatable does it automatically). The sweep is cross-tenant by design and only
 * ever deletes records past each company's own dataRetentionDays, so it is gated
 * to OWNER/ADMIN. Returns the deletion summary.
 */
@Controller('hr/admin/retention')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class HrRetentionController {
  constructor(private readonly retention: HrRetentionService) {}

  @Post('run-now')
  @HttpCode(200)
  runNow(): Promise<HrRetentionResultDto> {
    return this.retention.runRetention(new Date());
  }
}
