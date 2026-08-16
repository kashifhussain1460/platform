/**
 * POC ONLY — NOT PRODUCTION.
 *
 * File-backed fault injection. File-backed rather than in-memory on purpose:
 * "fail the first two attempts" has to mean the same thing after the process is
 * killed, otherwise POC-04/05 would silently degrade into a fresh run every
 * time and the POC would report a pass it never earned.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { record } from './recorder';

const STORE = resolve(process.cwd(), 'evidence', 'faults.json');

function load(): Record<string, number> {
  if (!existsSync(STORE)) return {};
  return JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, number>;
}

function save(state: Record<string, number>): void {
  const dir = dirname(STORE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE, JSON.stringify(state, null, 2), 'utf8');
}

/** Increment and return how many times this key has been seen (1-based). */
export function bump(key: string): number {
  const state = load();
  const n = (state[key] ?? 0) + 1;
  state[key] = n;
  save(state);
  return n;
}

export function seen(key: string): number {
  return load()[key] ?? 0;
}

/**
 * Hard-kill the process. Used to prove crash recovery for real — a mocked
 * "pretend we crashed" would invalidate POC-04 and POC-05 entirely.
 */
export function hardCrash(reason: string): never {
  record('process.crash', { reason, pid: process.pid });
  process.exit(137);
}
