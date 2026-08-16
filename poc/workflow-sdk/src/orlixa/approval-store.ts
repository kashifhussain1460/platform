/**
 * POC ONLY — NOT PRODUCTION.
 *
 * Minimal stand-in for Orlixa's ApprovalService. File-backed so a pending
 * approval survives the process restart in POC-09 — the same property Orlixa
 * gets from Postgres.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { record } from './recorder';

const STORE = resolve(process.cwd(), 'evidence', 'approvals.json');

export interface ApprovalRequest {
  id: string;
  companyId: string;
  runId: string;
  nodeId: string;
  /** The Workflow SDK hook token this approval will resume. */
  hookToken: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
}

function load(): Record<string, ApprovalRequest> {
  if (!existsSync(STORE)) return {};
  return JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, ApprovalRequest>;
}

function save(state: Record<string, ApprovalRequest>): void {
  const dir = dirname(STORE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE, JSON.stringify(state, null, 2), 'utf8');
}

export function createApproval(input: Omit<ApprovalRequest, 'status' | 'createdAt'>): ApprovalRequest {
  const state = load();
  // Idempotent by id: the step that creates it may be replayed.
  const existing = state[input.id];
  if (existing) return existing;
  const row: ApprovalRequest = { ...input, status: 'PENDING', createdAt: new Date().toISOString() };
  state[row.id] = row;
  save(state);
  record('approval.created', { approvalId: row.id, runId: row.runId, hookToken: row.hookToken });
  return row;
}

export function decideApproval(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  decidedBy: string,
): ApprovalRequest {
  const state = load();
  const row = state[id];
  if (!row) throw new Error(`Approval ${id} not found`);
  if (row.status !== 'PENDING') return row;
  row.status = decision;
  row.decidedBy = decidedBy;
  row.decidedAt = new Date().toISOString();
  save(state);
  record('approval.decided', { approvalId: id, decision, decidedBy });
  return row;
}

export function listApprovals(): ApprovalRequest[] {
  return Object.values(load());
}
