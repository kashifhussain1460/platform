import {
  Controller,
  Get,
  Param,
  Query,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { RunEventStreamService } from './run-event-stream.service';

/**
 * WAVE 5 §5.5 — realtime execution updates.
 *
 * ```
 * Worker → RunEventOutbox → relay → RunEventStreamService → SSE → Execution UI
 * ```
 *
 * **SSE, not WebSockets.** The data flows one way (server → UI), SSE is plain
 * HTTP so it inherits the existing JWT guard, tenant scoping, proxies and
 * load balancers unchanged, and browsers reconnect on their own. A WebSocket
 * gateway would mean a second authentication path and a second tenant-scoping
 * path — two more places for an isolation bug — to gain a channel back that the
 * execution view does not need.
 *
 * `Last-Event-ID` / `?after=` is what makes this safe rather than merely live:
 * a client that reconnects (or was never connected when a step finished) asks
 * for everything after the last `seq` it saw, so a dropped connection cannot
 * silently lose a run's completion.
 */
@Controller('workflows/runs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RunEventsController {
  constructor(private readonly stream: RunEventStreamService) {}

  /**
   * Everything already recorded for a run, oldest first.
   *
   * The catch-up read the stream is built on, and useful on its own: it is the
   * run timeline, and it works when SSE is blocked by a corporate proxy.
   */
  @Get(':id/events')
  history(
    @CurrentTenant() companyId: string,
    @Param('id') runId: string,
    @Query('after') after?: string,
  ) {
    return this.stream.history(companyId, runId, Number(after ?? 0) || 0);
  }

  @Sse(':id/stream')
  stream$(
    @CurrentTenant() companyId: string,
    @Param('id') runId: string,
    @Query('after') after?: string,
  ): Observable<MessageEvent> {
    return this.stream.subscribe(companyId, runId, Number(after ?? 0) || 0);
  }
}
