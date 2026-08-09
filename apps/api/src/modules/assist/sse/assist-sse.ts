import type { Response } from 'express';
import type { AssistStreamEvent } from '@vaep/types';

/**
 * Server-Sent Events plumbing for an assist turn.
 *
 * Why hand-rolled rather than Nest's `@Sse()`: that decorator is GET-shaped and
 * returns an `Observable`, but a turn needs a request BODY (what the user said).
 * Writing the raw response is the supported way to do a POST-with-stream, and it
 * keeps abort handling explicit.
 *
 * Why SSE rather than WebSockets: this is one-way server→client for the lifetime
 * of a single turn. A WS gateway would drag in the deferred P5-01 decision about
 * exposing a public socket host, for no benefit here.
 */

/** 15s — long enough to be quiet, short enough to beat idle-connection reapers. */
const HEARTBEAT_MS = 15_000;

export interface AssistSseChannel {
  send(event: AssistStreamEvent): void;
  /** Send the final frame and end the response. Safe to call twice. */
  close(): void;
  /** True once the client has gone away — stop doing expensive work. */
  get aborted(): boolean;
}

export function openAssistSse(res: Response): AssistSseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // `no-transform` matters as much as `no-cache`: a proxy that "helpfully"
    // compresses or rewrites the body will buffer the whole stream.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers proxied responses by default, which delivers the entire
    // stream at the end and makes streaming look broken while being "fine".
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the client's reader starts before the first
  // token, rather than waiting on the initial chunk.
  res.flushHeaders?.();

  let closed = false;
  let aborted = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    // An SSE comment: ignored by every client, keeps intermediaries from
    // reaping an idle connection while the model is thinking.
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const onClientGone = () => {
    aborted = true;
    clearInterval(heartbeat);
    closed = true;
  };
  res.on('close', onClientGone);

  return {
    send(event) {
      if (closed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.removeListener('close', onClientGone);
      res.end();
    },
    get aborted() {
      return aborted;
    },
  };
}
