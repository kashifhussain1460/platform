import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  runWithContext,
  traceIdFromTraceparent,
} from './execution-context';
import { activeTraceId } from './tracing';

/**
 * WAVE 5 §5.1 — open an execution context for every inbound request.
 *
 * A MIDDLEWARE, not an interceptor: interceptors run after guards, so anything
 * a guard logs or audits (every authorization denial, which is exactly what you
 * want correlated) would fall outside the context. Middleware wraps the whole
 * request.
 *
 * `companyId`/`userId` are NOT set here — they are not known until the JWT guard
 * has run — so they are enriched later by the guard. Setting them from an
 * unverified header would put attacker-controlled values into every log line.
 */
@Injectable()
export class ExecutionContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId =
      header(req, 'x-request-id') ?? header(req, 'x-vercel-id') ?? randomUUID();
    // Priority matters, and the OTel span sits THIRD on purpose:
    //   1. an inbound `traceparent` — a chain that began before this process
    //   2. an explicit `x-trace-id` — a client that manages its own ids
    //   3. the active span, when tracing is on, so a log line and the span
    //      describing the same request carry the SAME id
    //   4. the request id, so correlation still works with tracing off
    //
    // Step 3 is easy to leave out and impossible to notice: everything looks
    // correlated, because logs agree with each other — they just have no id in
    // common with the trace, so Jaeger and the log search can never meet. Caught
    // by running it, not by a test: the first version of this passed its unit
    // tests and still logged UUIDs while spans carried 32-hex ids.
    const traceId =
      traceIdFromTraceparent(header(req, 'traceparent')) ??
      header(req, 'x-trace-id') ??
      activeTraceId() ??
      requestId;

    // Echo it back so a caller can quote the id in a support ticket, and a
    // client can attach it to its own error reports.
    res.setHeader('x-request-id', requestId);

    runWithContext(
      {
        requestId,
        traceId,
        // Recorded for the audit trail. Safe to take from the transport because
        // they describe the connection and are never trusted for a decision —
        // unlike identity, which waits for the JWT guard.
        ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent: header(req, 'user-agent'),
      },
      () => next(),
    );
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}
