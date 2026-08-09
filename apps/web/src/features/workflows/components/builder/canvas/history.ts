/**
 * Pure undo/redo checkpoint history for the workflow canvas.
 *
 * `stack[index]` is the current state. Pushing a checkpoint drops any redo tail
 * (you can't redo into a branch you've diverged from) and skips no-op pushes so
 * an identical re-save doesn't create an empty undo step. Kept pure + separate
 * so the tricky navigation/truncation logic is unit-tested independently of the
 * React canvas that drives it.
 */
export interface History<T> {
  stack: T[];
  index: number;
}

export function initHistory<T>(initial: T): History<T> {
  return { stack: [initial], index: 0 };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.index > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.index < h.stack.length - 1;
}

export function current<T>(h: History<T>): T {
  return h.stack[h.index];
}

/** Append `next` as the new current, dropping the redo tail. No-op if unchanged. */
export function pushCheckpoint<T>(
  h: History<T>,
  next: T,
  eq: (a: T, b: T) => boolean,
): History<T> {
  if (h.index >= 0 && eq(h.stack[h.index], next)) return h;
  const stack = [...h.stack.slice(0, h.index + 1), next];
  return { stack, index: stack.length - 1 };
}

export function undo<T>(h: History<T>): History<T> {
  return canUndo(h) ? { stack: h.stack, index: h.index - 1 } : h;
}

export function redo<T>(h: History<T>): History<T> {
  return canRedo(h) ? { stack: h.stack, index: h.index + 1 } : h;
}
