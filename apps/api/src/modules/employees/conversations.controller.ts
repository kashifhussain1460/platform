import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { MessageDto, RunResultDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SendMessageDto } from './dto/send-message.dto';
import { EmployeesService } from './employees.service';

/** Conversation-scoped message routes (tenant-scoped, JWT-guarded). */
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly employees: EmployeesService) {}

  @Get(':id/messages')
  listMessages(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<MessageDto[]> {
    return this.employees.listMessages(companyId, id, limit);
  }

  /**
   * Send a user message → run one agent turn → return the RunResultDto (the
   * user + assistant messages are persisted). Rejects with 409 if the employee
   * is PAUSED/DISABLED.
   *
   * `Idempotency-Key` (optional, same header convention as
   * `workflows.controller.ts`'s run endpoint): a duplicate submission with
   * the same key on this conversation replays the original RunResultDto
   * instead of running the agent loop — and the model call — a second time
   * (credit-system prerequisite, kill-critic Q3(a)).
   */
  @Post(':id/messages')
  sendMessage(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunResultDto> {
    return this.employees.sendMessage(companyId, id, dto.content, idempotencyKey ?? null);
  }
}
