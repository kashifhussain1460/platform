import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { StaffDocumentDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateStaffDocumentDto } from './dto/staff-document.dto';
import { StaffDocumentService } from './staff-document.service';

/** Staff documents (P3-01). File metadata only; scans live in object storage. OWNER/ADMIN only. */
@Controller('hr/documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class StaffDocumentController {
  constructor(private readonly documents: StaffDocumentService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('staffId') staffId?: string,
  ): Promise<StaffDocumentDto[]> {
    if (!staffId) {
      throw new BadRequestException('staffId query parameter is required');
    }
    return this.documents.list(companyId, staffId);
  }

  @Post()
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStaffDocumentDto,
  ): Promise<StaffDocumentDto> {
    return this.documents.create(companyId, dto, user.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.documents.remove(companyId, id, user.userId);
  }
}
