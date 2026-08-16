/**
 * POC ONLY — NOT PRODUCTION.
 *
 * Stands in for a real provider (Postiz / Chatwoot / Plane / Gmail). It is
 * deliberately a *stateful* provider: it keeps a table of idempotency keys it
 * has already honoured, exactly like Stripe or Postiz would, so the POC can
 * tell the difference between
 *
 *   (a) the SDK never issued a duplicate call, and
 *   (b) the SDK issued a duplicate call and the PROVIDER absorbed it.
 *
 * That distinction is the entire point of POC-05 and POC-06. A mock that simply
 * counts calls would report "no duplicate" for both, which is the classic way a
 * durability POC lies to you.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { record } from './recorder';

const STORE = resolve(process.cwd(), 'evidence', 'external-api-state.json');

interface ProviderState {
  /** idempotencyKey -> the resource id issued for it. */
  honoured: Record<string, string>;
  /** Raw wire log: EVERY inbound request, including deduplicated ones. */
  requests: Array<{
    at: string;
    requestId: string;
    idempotencyKey: string | null;
    executionId: string;
    payload: unknown;
    deduplicated: boolean;
  }>;
}

function load(): ProviderState {
  if (!existsSync(STORE)) return { honoured: {}, requests: [] };
  return JSON.parse(readFileSync(STORE, 'utf8')) as ProviderState;
}

function save(state: ProviderState): void {
  const dir = dirname(STORE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Synchronous on purpose: a step may `process.exit()` on the next line.
  writeFileSync(STORE, JSON.stringify(state, null, 2), 'utf8');
}

export interface ProviderCall {
  executionId: string;
  idempotencyKey: string | null;
  payload: unknown;
}

export interface ProviderResult {
  resourceId: string;
  deduplicated: boolean;
  requestId: string;
}

/** The "external API". Honours an idempotency key if one is supplied. */
export function callExternalApi(call: ProviderCall): ProviderResult {
  const state = load();
  const requestId = `req_${state.requests.length + 1}_${Math.random().toString(36).slice(2, 8)}`;

  const prior = call.idempotencyKey ? state.honoured[call.idempotencyKey] : undefined;
  const deduplicated = prior !== undefined;
  const resourceId = prior ?? `res_${Object.keys(state.honoured).length + 1}`;

  if (call.idempotencyKey && !deduplicated) {
    state.honoured[call.idempotencyKey] = resourceId;
  }
  state.requests.push({
    at: new Date().toISOString(),
    requestId,
    idempotencyKey: call.idempotencyKey,
    executionId: call.executionId,
    payload: call.payload,
    deduplicated,
  });
  save(state);

  record('external.call', {
    requestId,
    executionId: call.executionId,
    idempotencyKey: call.idempotencyKey,
    resourceId,
    deduplicated,
    payload: call.payload,
  });

  return { resourceId, deduplicated, requestId };
}

export function providerState(): ProviderState {
  return load();
}

export function resetProvider(): void {
  save({ honoured: {}, requests: [] });
}
