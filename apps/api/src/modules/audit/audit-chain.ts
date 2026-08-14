import { createHash } from 'node:crypto';

/**
 * WAVE 4 §4.4 — tamper evidence, as a PURE function.
 *
 * The trail was append-only by convention: nothing stopped a row being edited
 * or deleted straight in the database, and nothing would ever reveal it. A hash
 * chain does not PREVENT that — anyone with write access can still change a row
 * — but it makes the change *detectable*, which is the property a compliance
 * reviewer actually needs. "Nobody tampered with this" is unprovable; "any
 * tampering would show" is provable.
 *
 * Pure and separate from the service so the hashing rule can be tested without
 * a database, and so an auditor can re-implement it from this file alone.
 */

/** The fields that are covered by the hash. */
export interface ChainableEntry {
  companyId: string;
  seq: bigint | number;
  actorUserId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  employeeId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  correlationId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
}

/**
 * The exact bytes that get hashed.
 *
 * Built field-by-field in a FIXED order rather than by `JSON.stringify`-ing the
 * row: object key order is not guaranteed across drivers or Prisma versions, and
 * a hash whose input order can drift would report false tampering after a
 * dependency upgrade — which is worse than no chain, because it destroys trust
 * in the one signal that is supposed to be trustworthy.
 *
 * `metadata` is canonicalised with sorted keys for the same reason.
 */
export function canonicalPayload(entry: ChainableEntry): string {
  return [
    entry.companyId,
    String(entry.seq),
    entry.actorUserId ?? '',
    entry.actorType,
    entry.action,
    entry.entityType,
    entry.entityId ?? '',
    entry.employeeId ?? '',
    entry.workflowId ?? '',
    entry.workflowRunId ?? '',
    entry.correlationId ?? '',
    entry.ip ?? '',
    entry.userAgent ?? '',
    canonicalJson(entry.metadata),
    entry.createdAt.toISOString(),
  ].join(FIELD_SEPARATOR);
}

/**
 * ASCII unit separator, as an ESCAPE rather than a literal control character in
 * source (which is invisible in a diff and easy to lose in a copy/paste).
 *
 * A real separator matters: with an empty join, `["ab","c"]` and `["a","bc"]`
 * produce identical bytes, so a character could be shifted between two adjacent
 * fields and the hash would still verify. U+001F cannot occur in an id, an
 * action name or an ISO timestamp.
 */
const FIELD_SEPARATOR = '\u001f';

/**
 * `eventHash = sha256(previousHash || canonicalPayload)`.
 *
 * Including the predecessor's hash is what makes it a CHAIN rather than a set of
 * independent checksums: deleting entry N invalidates N+1, so removing history
 * is as visible as editing it. Row-wise checksums would happily survive a
 * deletion.
 */
export function computeEventHash(
  entry: ChainableEntry,
  previousHash: string | null,
): string {
  return createHash('sha256')
    .update(`${previousHash ?? 'GENESIS'}${canonicalPayload(entry)}`)
    .digest('hex');
}

/** Stable JSON: object keys sorted at every level, arrays left in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export type ChainBreakKind =
  /** An entry written before the chain existed — expected, not tampering. */
  | 'UNCHAINED'
  /** `eventHash` does not match the entry's own content: it was EDITED. */
  | 'CONTENT_MISMATCH'
  /** `previousHash` does not match the predecessor: an entry was REMOVED or reordered. */
  | 'LINK_MISMATCH'
  /** A hole in `seq`: an entry was DELETED. */
  | 'SEQUENCE_GAP';

export interface ChainBreak {
  seq: string;
  id: string;
  kind: ChainBreakKind;
  detail: string;
}

export interface ChainVerification {
  checked: number;
  /** Entries that predate the chain; reported separately, never as tampering. */
  unchained: number;
  breaks: ChainBreak[];
  valid: boolean;
}

/**
 * Walk a company's entries in `seq` order and report every break.
 *
 * Returns ALL breaks rather than stopping at the first: after a genuine
 * incident, "where does the damage start and stop" is the question being asked,
 * and a verifier that gives up at the first mismatch cannot answer it.
 */
export function verifyChain(
  entries: readonly (ChainableEntry & {
    id: string;
    previousHash: string | null;
    eventHash: string | null;
  })[],
): ChainVerification {
  const breaks: ChainBreak[] = [];
  let unchained = 0;
  let expectedPrevious: string | null = null;
  let expectedSeq: bigint | null = null;

  for (const entry of entries) {
    const seq = BigInt(entry.seq);

    if (expectedSeq !== null && seq !== expectedSeq) {
      breaks.push({
        seq: String(seq),
        id: entry.id,
        kind: 'SEQUENCE_GAP',
        detail: `Expected seq ${expectedSeq}, found ${seq} — ${seq - expectedSeq} entr${seq - expectedSeq === 1n ? 'y was' : 'ies were'} deleted`,
      });
    }
    expectedSeq = seq + 1n;

    if (!entry.eventHash) {
      unchained++;
      // A pre-chain entry cannot anchor the next link, so restart from here.
      expectedPrevious = null;
      continue;
    }

    const recomputed = computeEventHash(entry, entry.previousHash);
    if (recomputed !== entry.eventHash) {
      breaks.push({
        seq: String(seq),
        id: entry.id,
        kind: 'CONTENT_MISMATCH',
        detail: 'This entry’s content does not match its recorded hash',
      });
    } else if (
      expectedPrevious !== null &&
      entry.previousHash !== expectedPrevious
    ) {
      breaks.push({
        seq: String(seq),
        id: entry.id,
        kind: 'LINK_MISMATCH',
        detail: 'This entry does not link to the preceding entry',
      });
    }

    expectedPrevious = entry.eventHash;
  }

  return {
    checked: entries.length,
    unchained,
    breaks,
    valid: breaks.length === 0,
  };
}
