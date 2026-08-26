import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { knowledgeUploadMaxBytes } from '../../common/config/credit-abuse.constants';
import type { KnowledgeDocumentDto, SearchResultDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { SearchDto } from './dto/search.dto';
import { UpdateDocumentCategoryDto } from './dto/update-document-category.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { KnowledgeService, type UploadedDocFile } from './knowledge.service';

/** All routes are tenant-scoped by companyId from the JWT and JWT-guarded. */
@Controller('knowledge')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  /**
   * Upload a document (multipart field `file`, buffered in memory by
   * Multer). Credit system Phase 10, Task 10.6 (§26) — a size ceiling
   * independent of credit balance: an oversized upload is rejected before
   * ANY ingestion work (extract/chunk/embed) starts, not priced and blocked
   * mid-way.
   */
  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: knowledgeUploadMaxBytes() } }))
  upload(
    @CurrentTenant() companyId: string,
    @UploadedFile() file: UploadedDocFile,
    @Body() dto: UploadDocumentDto,
  ): Promise<KnowledgeDocumentDto> {
    return this.knowledge.upload(companyId, file, dto.category);
  }

  @Get('documents')
  list(
    @CurrentTenant() companyId: string,
    @Query() query: ListDocumentsQueryDto,
  ): Promise<KnowledgeDocumentDto[]> {
    return this.knowledge.list(companyId, query.category, query.limit);
  }

  @Get('documents/:id')
  get(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<KnowledgeDocumentDto> {
    return this.knowledge.get(companyId, id);
  }

  /** Raw file bytes (inline disposition) for a "View" button / opening in a new tab. */
  @Get('documents/:id/content')
  async content(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, mimeType, filename } = await this.knowledge.getContent(
      companyId,
      id,
    );
    res.set({
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
    });
    return new StreamableFile(buffer);
  }

  @Patch('documents/:id/category')
  updateCategory(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentCategoryDto,
  ): Promise<KnowledgeDocumentDto> {
    return this.knowledge.updateCategory(companyId, id, dto.category);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    // The caller is passed so the delete is department-scoped and audited.
    return this.knowledge.remove(companyId, id, user.userId);
  }

  @Post('search')
  search(
    @CurrentTenant() companyId: string,
    @Body() dto: SearchDto,
  ): Promise<SearchResultDto[]> {
    return this.knowledge.search(companyId, dto);
  }
}
