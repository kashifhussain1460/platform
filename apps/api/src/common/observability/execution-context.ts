import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { activeTraceId } from './tracing';

/**
 * WAVE 5 §5.1 — the execution context, carried implicitly.
 *
 * Every field the plan lists, so one identifier ties a log line, an audit entry,
 * a metric and a run together. The point of the chain is the question it makes
 * answerable: "a customer says their onboarding workflow misfired at 14:02" —
 * without correlation that is an archaeology exercise across four systems.
 *
 * `AsyncLocalStorage` rather than a threaded parameter, deliberately. Threading
 * a context object through every service signature is more explicit, and it is
 * also how correlation dies: it survives exactly as long as someone remembers to
 * pass it, and the one place it gets dropped is the place you needed it. ALS
 * follows async continuations automatically, so a log line five awaits deep
 * inside a node handler still knows which run it belongs to.
 *
 * The trade is real and worth naming: ALS is implicit, so a context set in one
 * place appears "by magic" in another, and it does NOT cross a process boundary
 * — a BullMQ job starts with an empty store. That is why the worker entry points
 * re-establish it from the job payload rather than assuming it survived.
 */
export interface ExecutionContext {
  /** One inbound HTTP request or one queue job. */
  requestId: string;
  /** Spans the whole causal chain, including across queue hops. */
  traceId: string;
  companyId?: string;
  userId?: string;
  employeeId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  workflowRunId?: string;
  stepRunId?: string;
  attemptId?: string;
  skillExecutionId?: string;
  /** The provider-side request id, when a provider returns one. */
  externalRequestId?: string;
  /** The business-level correlation id (event id, run correlationId). */
  correlationId?: string;
  /**
   * Request facts, for the audit trail. Unlike identity these are safe to take
   * from the transport: they describe the CONNECTION, and are recorded as
   * claims about it rather than trusted for any decision.
   */
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

/** The ambient context, or undefined outside any tracked scope. */
export function currentContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/** Run `fn` with a fresh context. Nested calls MERGE onto the current one. */
export function runWithContext<T>(
  context: Partial<ExecutionContext>,
  fn: () => T,
): T {
  const parent = storage.getStore();
  const merged: ExecutionContext = {
    requestId: context.requestId ?? parent?.requestId ?? randomUUID(),
    // Prefer the ACTIVE SPAN's trace id when tracing is on, so a log line and
    // the span describing the same work share one id. Two correlation ids for
    // one request is the usual reason a team owns traces and still greps logs.
    // Ranked below an explicit/inherited id so an inbound `traceparent` (or a
    // re-established job context) still wins — those represent a chain that
    // started before this process.
    traceId:
      context.traceId ?? parent?.traceId ?? activeTraceId() ?? randomUUID(),
    ...parent,
    ...stripUndefined(context),
  };
  return storage.run(merged, fn);
}

/**
 * Add fields to the CURRENT context in place.
 *
 * Used when a value is only learned partway through — a run id that did not
 * exist when the request began, say. A no-op outside a tracked scope, so a
 * caller never has to guard.
 */
export function enrichContext(patch: Partial<ExecutionContext>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, stripUndefined(patch));
}

/**
 * Parse W3C `traceparent` (`00-<32 hex trace>-<16 hex span>-<flags>`).
 *
 * Accepting an inbound trace id is what lets a customer's own tracing, or a
 * gateway's, join up with ours instead of starting a second disconnected trace
 * for the same request.
 */
export function traceIdFromTraceparent(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const parts = header.split('-');
  if (parts.length < 4) return undefined;
  const traceId = parts[1];
  // Reject the all-zero id the spec defines as invalid, and anything malformed:
  // a bad value is worse than none, because it silently groups unrelated work.
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) return undefined;
  return traceId;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
