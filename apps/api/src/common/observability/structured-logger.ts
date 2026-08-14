import { ConsoleLogger, type LoggerService, type LogLevel } from '@nestjs/common';
import { currentContext } from './execution-context';

/**
 * WAVE 5 §5.2 — one JSON object per line, carrying the ambient context.
 *
 * The gate item is "logs searchable by workflowRunId", and Nest's default
 * `[Nest] 123 - LOG [WorkflowEngine] workflow.run start run=abc` cannot satisfy
 * it: the run id is inside prose, so finding every line for a run means a
 * substring grep that also matches ids embedded in other text, and correlating
 * across services is impossible. Emitting the ids as FIELDS makes it a query.
 *
 * Off by default (`LOG_FORMAT=json` opts in) so local development keeps the
 * readable console output, and so this ships without changing what anyone
 * currently reads.
 */
export class StructuredLogger extends ConsoleLogger implements LoggerService {
  constructor(private readonly json: boolean) {
    super();
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest, () => super.log(message as string, ...(rest as [])));
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest, () =>
      super.error(message as string, ...(rest as [])),
    );
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest, () => super.warn(message as string, ...(rest as [])));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest, () =>
      super.debug(message as string, ...(rest as [])),
    );
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest, () =>
      super.verbose(message as string, ...(rest as [])),
    );
  }

  private emit(
    level: LogLevel | 'info',
    message: unknown,
    rest: unknown[],
    fallback: () => void,
  ): void {
    if (!this.json) {
      fallback();
      return;
    }
    // Nest passes the context (class name) as the LAST argument; anything before
    // it on `error` is the stack.
    const context = typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] : undefined;
    const stack = rest.length > 1 && typeof rest[0] === 'string' ? rest[0] : undefined;

    const line = {
      level,
      time: new Date().toISOString(),
      logger: context ?? undefined,
      message:
        typeof message === 'string' ? message : safeStringify(message),
      ...(stack ? { stack } : {}),
      // Spread LAST so the correlation fields are never shadowed by a log
      // call that happens to use the same key name.
      ...currentContext(),
    };
    // eslint-disable-next-line no-console -- this IS the log sink
    console.log(safeStringify(line));
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v,
    );
  } catch {
    return String(value);
  }
}

/** `LOG_FORMAT=json` turns structured logging on. */
export function structuredLoggingEnabled(): boolean {
  return (process.env.LOG_FORMAT ?? '').toLowerCase() === 'json';
}
