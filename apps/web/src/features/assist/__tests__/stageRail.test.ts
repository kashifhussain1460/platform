import { describe, expect, it } from 'vitest';
import { deriveStages, type AssistStageRailInput } from '../components/AssistStageRail';

const base: AssistStageRailInput = {
  streaming: false,
  hasMessages: false,
  nodeCount: 0,
  unresolvedCount: 0,
  testCount: 0,
  created: false,
};
const statusOf = (i: AssistStageRailInput, key: string) =>
  deriveStages(i).find((s) => s.key === key)!.status;

describe('deriveStages (doc 31 Architect rail)', () => {
  it('a fresh session: everything upcoming', () => {
    expect(statusOf(base, 'understand')).toBe('upcoming');
    expect(statusOf(base, 'design')).toBe('upcoming');
    expect(statusOf(base, 'validate')).toBe('upcoming');
  });

  it('while streaming with no graph yet: understanding is active', () => {
    const i = { ...base, streaming: true };
    expect(statusOf(i, 'understand')).toBe('active');
    expect(statusOf(i, 'design')).toBe('active');
    expect(statusOf(i, 'validate')).toBe('upcoming');
  });

  it('a built, clean graph (not streaming): design done, validate done, ready active', () => {
    const i = { ...base, hasMessages: true, nodeCount: 8 };
    expect(statusOf(i, 'understand')).toBe('done');
    expect(statusOf(i, 'design')).toBe('done');
    expect(statusOf(i, 'validate')).toBe('done');
    expect(statusOf(i, 'ready')).toBe('active');
    expect(statusOf(i, 'build')).toBe('upcoming');
  });

  it('unresolved issues flip validate to warning and block ready', () => {
    const i = { ...base, hasMessages: true, nodeCount: 8, unresolvedCount: 2 };
    expect(statusOf(i, 'validate')).toBe('warning');
    expect(statusOf(i, 'ready')).toBe('upcoming');
  });

  it('once the workflow is created: ready and build are done', () => {
    const i = { ...base, hasMessages: true, nodeCount: 8, created: true };
    expect(statusOf(i, 'ready')).toBe('done');
    expect(statusOf(i, 'build')).toBe('done');
  });
});
