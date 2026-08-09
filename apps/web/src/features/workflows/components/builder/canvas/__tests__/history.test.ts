import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  current,
  initHistory,
  pushCheckpoint,
  redo,
  undo,
} from '../history';

const eq = (a: number, b: number) => a === b;

describe('canvas undo/redo history', () => {
  it('starts at the initial checkpoint with nothing to undo/redo', () => {
    const h = initHistory(0);
    expect(current(h)).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('push adds a checkpoint and enables undo', () => {
    let h = initHistory(0);
    h = pushCheckpoint(h, 1, eq);
    expect(current(h)).toBe(1);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
  });

  it('undo then redo round-trips', () => {
    let h = pushCheckpoint(pushCheckpoint(initHistory(0), 1, eq), 2, eq);
    h = undo(h);
    expect(current(h)).toBe(1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(current(h)).toBe(2);
  });

  it('an identical push is a no-op (no empty undo step)', () => {
    let h = pushCheckpoint(initHistory(0), 1, eq);
    const before = h;
    h = pushCheckpoint(h, 1, eq);
    expect(h).toBe(before);
    expect(current(h)).toBe(1);
  });

  it('pushing after an undo drops the redo tail', () => {
    let h = pushCheckpoint(pushCheckpoint(initHistory(0), 1, eq), 2, eq);
    h = undo(h); // back to 1, redo tail = [2]
    expect(canRedo(h)).toBe(true);
    h = pushCheckpoint(h, 9, eq); // diverge
    expect(current(h)).toBe(9);
    expect(canRedo(h)).toBe(false); // the 2 is gone
    expect(h.stack).toEqual([0, 1, 9]);
  });

  it('undo/redo at the ends are safe no-ops', () => {
    const h = initHistory(0);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
