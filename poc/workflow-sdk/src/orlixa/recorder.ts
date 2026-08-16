/**
 * POC ONLY — NOT PRODUCTION.
 *
 * A crash-proof append-only recorder. Every external side effect, every
 * authorization decision and every approval transition is appended here as one
 * JSON line, flushed with `appendFileSync` so the record survives a
 * `process.exit()` in the middle of a step.
 *
 * The whole POC is judged from this file. If a side effect happened twice, this
 * file says so — nothing in the assertions is allowed to depend on in-memory
 * state, because in-memory state is exactly what a crash destroys.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const LOG = resolve(process.cwd(), 'evidence', 'ledger.jsonl');

export interface LedgerEntry {
  at: string;
  kind: string;
  [key: string]: unknown;
}

export function record(kind: string, data: Record<string, unknown>): void {
  const dir = dirname(LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`, 'utf8');
}

export function readLedger(): LedgerEntry[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export function ledgerPath(): string {
  return LOG;
}
