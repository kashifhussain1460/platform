import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import type {
  AssistSessionDto,
  AssistSessionSummaryDto,
  AssistSuggestionDto,
  WorkflowDto,
} from '@vaep/types';
import { RequirePlan } from '../billing/decorators/plan.decorator';
import { PlanGuard } from '../billing/plan.guard';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AssistService } from './assist.service';
import { openAssistSse } from './sse/assist-sse';
import {
  AcceptAssistSessionDto,
  AssistStreamTurnDto,
  AssistTurnDto,
  CreateAssistSessionDto,
  ListAssistSessionsDto,
} from './dto/assist.dto';

/**
 * Orlixa AI Assist (doc 30). Plan-gated to BUSINESS/ENTERPRISE like the existing
 * `/workflows/generate`, because every turn is real LLM spend.
 *
 * Deliberately NOT `@Roles()`-gated at the class level: BUILDING is member-level
 * so anyone can explore, while ACCEPTING (which creates a real workflow) is
 * checked in the service against OWNER/ADMIN. A blanket decorator here would
 * either lock members out of the whole feature or let them create workflows.
 *
 * The streaming turn endpoint arrives in wave A3; this is the session lifecycle.
 */
@Controller('assist')
@UseGuards(JwtAuthGuard, RolesGuard, PlanGuard)
@RequirePlan('BUSINESS', 'ENTERPRISE')
export class AssistController {
  constructor(private readonly assist: AssistService) {}

  /** Entry-screen chips, grounded in the tenant's own employees. */
  @Get('suggestions')
  suggestions(
    @CurrentTenant() companyId: string,
  ): Promise<AssistSuggestionDto[]> {
    return this.assist.suggestions(companyId);
  }

  @Get('sessions')
  list(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAssistSessionsDto,
  ): Promise<AssistSessionSummaryDto[]> {
    return this.assist.list(companyId, user, query);
  }

  @Post('sessions')
  // Cheap endpoint, but one session per click — this only stops a runaway client.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAssistSessionDto,
  ): Promise<AssistSessionDto> {
    return this.assist.create(companyId, user, dto);
  }

  @Get('sessions/:id')
  get(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<AssistSessionDto> {
    return this.assist.get(companyId, user, id);
  }

  /**
   * Say something to the agent and get the updated session back.
   *
   * Non-streaming (wave A2). Wave A3 adds an SSE variant alongside this; the
   * plain JSON form stays as the honest degrade for any client that cannot
   * stream, and as the simplest thing to test.
   *
   * Rate-limited hard: one turn is several LLM completions.
   */
  @Post('sessions/:id/turns')
  @Throttle({ default: { limit: 20, ttl: 5 * 60_000 } })
  turn(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssistTurnDto,
  ): Promise<AssistSessionDto> {
    return this.assist.turn(companyId, user, id, dto.text);
  }

  /**
   * The same turn, streamed as Server-Sent Events.
   *
   * A separate path rather than content negotiation on `/turns`: it is trivially
   * curl-able, and it keeps the JSON endpoint above as a working degrade for any
   * client that cannot stream (doc 30 §19.1's honesty rule).
   *
   * `@Res({ passthrough: false })` — we own the response, so Nest must not try to
   * serialise a return value on top of the stream.
   */
  @Post('sessions/:id/turns/stream')
  @Throttle({ default: { limit: 20, ttl: 5 * 60_000 } })
  async turnStream(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssistStreamTurnDto,
    @Res() res: Response,
  ): Promise<void> {
    const channel = openAssistSse(res);
    try {
      const session = await this.assist.turn(
        companyId,
        user,
        id,
        dto.text ?? '',
        (event) => channel.send(event),
      );
      channel.send({
        type: 'done',
        finished: session.status === 'COMPLETED',
      });
    } catch (err) {
      // Errors arrive INSIDE the stream: headers are already sent, so a thrown
      // exception could not become an HTTP status anyway. A 4xx-shaped failure
      // (budget, turn cap) is the user's to act on and not worth retrying.
      const status = (err as { status?: number })?.status ?? 500;
      channel.send({
        type: 'error',
        code: String(status),
        message:
          err instanceof Error
            ? err.message
            : 'Something went wrong while building.',
        retryable: status >= 500,
      });
      // Still exactly one `done`, always last — clients close on it.
      channel.send({ type: 'done', finished: false });
    } finally {
      channel.close();
    }
  }

  /** Turn the draft into a real workflow (OWNER/ADMIN — enforced in the service). */
  @Post('sessions/:id/accept')
  accept(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AcceptAssistSessionDto,
  ): Promise<WorkflowDto> {
    return this.assist.accept(companyId, user, id, dto);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.assist.remove(companyId, user, id);
  }
}
