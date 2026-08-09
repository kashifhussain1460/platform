import { describe, expect, it } from 'vitest';
import type { WorkflowStepRunDto } from '@vaep/types';
import { stepStatusByNodeId } from '../runOverlay';

const step = (nodeId: string, status: WorkflowStepRunDto['status'], attempt = 1): WorkflowStepRunDto =>
  ({ id: `${nodeId}-${attempt}`, nodeId, status, attempt } as unknown as WorkflowStepRunDto);

describe('stepStatusByNodeId', () => {
  it('maps each node to its step status', () => {
    const map = stepStatusByNodeId([step('a', 'COMPLETED'), step('b', 'RUNNING')]);
    expect(map.get('a')).toBe('COMPLETED');
    expect(map.get('b')).toBe('RUNNING');
    expect(map.size).toBe(2);
  });

  it('keeps the latest attempt (last write wins) for a retried node', () => {
    const map = stepStatusByNodeId([
      step('a', 'FAILED', 1),
      step('a', 'RETRYING', 2),
      step('a', 'COMPLETED', 3),
    ]);
    expect(map.get('a')).toBe('COMPLETED');
  });

  it('tolerates undefined/empty steps', () => {
    expect(stepStatusByNodeId(undefined).size).toBe(0);
    expect(stepStatusByNodeId([]).size).toBe(0);
  });
});
