import {
  canonicalJson,
  canonicalPayload,
  computeEventHash,
  verifyChain,
  type ChainableEntry,
} from './audit-chain';

const base = (over: Partial<ChainableEntry> = {}): ChainableEntry => ({
  companyId: 'co1',
  seq: 1n,
  actorUserId: 'u1',
  actorType: 'USER',
  action: 'user.role_changed',
  entityType: 'User',
  entityId: 'u2',
  employeeId: null,
  workflowId: null,
  workflowRunId: null,
  correlationId: null,
  ip: null,
  userAgent: null,
  metadata: { from: 'MEMBER', to: 'ADMIN' },
  createdAt: new Date('2026-08-12T10:00:00.000Z'),
  ...over,
});

/** Build a valid chain of n entries. */
function chain(n: number) {
  const rows: (ChainableEntry & {
    id: string;
    previousHash: string | null;
    eventHash: string | null;
  })[] = [];
  let previousHash: string | null = null;
  for (let i = 1; i <= n; i++) {
    const entry = base({ seq: BigInt(i), entityId: `u${i}` });
    const eventHash = computeEventHash(entry, previousHash);
    rows.push({ ...entry, id: `a${i}`, previousHash, eventHash });
    previousHash = eventHash;
  }
  return rows;
}

describe('audit hash chain (WAVE 4 §4.4)', () => {
  it('verifies an untouched chain', () => {
    const result = verifyChain(chain(5));
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(5);
    expect(result.breaks).toEqual([]);
  });

  it('detects an EDITED entry', () => {
    const rows = chain(5);
    // Someone quietly rewrites history in the database.
    rows[2] = { ...rows[2], action: 'user.role_changed_but_not_really' };

    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.breaks[0]).toMatchObject({ seq: '3', kind: 'CONTENT_MISMATCH' });
  });

  it('detects a DELETED entry as a sequence gap AND a broken link', () => {
    const rows = chain(5).filter((r) => r.seq !== 3n);
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.breaks.map((b) => b.kind)).toEqual(
      expect.arrayContaining(['SEQUENCE_GAP', 'LINK_MISMATCH']),
    );
  });

  it('detects REORDERED entries', () => {
    const rows = chain(5);
    const swapped = [rows[0], rows[2], rows[1], rows[3], rows[4]];
    expect(verifyChain(swapped).valid).toBe(false);
  });

  it('reports EVERY break, not just the first', () => {
    // After a real incident the question is "where does the damage start and
    // stop" — a verifier that gives up at the first mismatch cannot answer it.
    const rows = chain(6);
    rows[1] = { ...rows[1], action: 'tampered-a' };
    rows[4] = { ...rows[4], action: 'tampered-b' };
    const result = verifyChain(rows);
    expect(result.breaks.length).toBeGreaterThanOrEqual(2);
  });

  it('treats pre-chain entries as UNCHAINED, not as tampering', () => {
    // Rows written before WAVE 4 have no hash. Reporting them as tampering
    // would cry wolf on every existing tenant from day one.
    const rows = chain(3).map((r, i) =>
      i === 0 ? { ...r, previousHash: null, eventHash: null } : r,
    );
    const result = verifyChain(rows);
    expect(result.unchained).toBe(1);
    expect(result.breaks).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('an empty trail is valid', () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  describe('the hash input', () => {
    it('changes when ANY covered field changes', () => {
      const h = (over: Partial<ChainableEntry>) =>
        computeEventHash(base(over), null);
      const original = h({});
      expect(h({ action: 'other' })).not.toBe(original);
      expect(h({ actorUserId: 'u9' })).not.toBe(original);
      expect(h({ actorType: 'SYSTEM' })).not.toBe(original);
      expect(h({ entityId: 'u9' })).not.toBe(original);
      expect(h({ metadata: { from: 'MEMBER', to: 'OWNER' } })).not.toBe(original);
      expect(h({ createdAt: new Date('2026-08-12T10:00:01.000Z') })).not.toBe(
        original,
      );
    });

    it('is stable across metadata KEY ORDER', () => {
      // Object key order is not guaranteed across drivers or Prisma versions. A
      // hash that depended on it would report false tampering after a dependency
      // upgrade — worse than no chain, because it destroys trust in the signal.
      const a = computeEventHash(base({ metadata: { x: 1, y: 2 } }), null);
      const b = computeEventHash(base({ metadata: { y: 2, x: 1 } }), null);
      expect(a).toBe(b);
    });

    it('separates fields, so content cannot be shifted between them', () => {
      // With an empty join, ("ab","c") and ("a","bc") hash identically.
      const a = canonicalPayload(base({ entityType: 'ab', entityId: 'c' }));
      const b = canonicalPayload(base({ entityType: 'a', entityId: 'bc' }));
      expect(a).not.toBe(b);
    });

    it('chains: the same entry hashes differently after a different predecessor', () => {
      const entry = base();
      expect(computeEventHash(entry, 'prev-a')).not.toBe(
        computeEventHash(entry, 'prev-b'),
      );
    });
  });

  describe('canonicalJson', () => {
    it('sorts keys at every depth', () => {
      expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
        '{"a":{"c":3,"d":2},"b":1}',
      );
    });

    it('preserves array order (order is meaningful there)', () => {
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });

    it('treats null and undefined alike', () => {
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(undefined)).toBe('null');
    });
  });
});
