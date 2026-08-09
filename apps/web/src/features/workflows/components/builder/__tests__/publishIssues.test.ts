import { describe, expect, it } from 'vitest';
import { splitPublishIssues } from '../publishIssues';

describe('splitPublishIssues', () => {
  it('returns a single-item list for a single-issue message', () => {
    expect(splitPublishIssues('A workflow may have at most one TRIGGER node; found 2')).toEqual([
      'A workflow may have at most one TRIGGER node; found 2',
    ]);
  });

  it('splits the multi-problem message into per-issue lines, stripping bullets and node ids', () => {
    const message =
      'Workflow definition has 2 problems:\n' +
      '• [n2] SET_VARIABLE node "n2" needs a variable name\n' +
      '• Edge references unknown node id "ghost"';
    expect(splitPublishIssues(message)).toEqual([
      '[n2] SET_VARIABLE node "n2" needs a variable name',
      'Edge references unknown node id "ghost"',
    ]);
  });

  it('handles "1 problem" singular and empty input', () => {
    expect(splitPublishIssues('Workflow definition has 1 problem:\n• only one')).toEqual(['only one']);
    expect(splitPublishIssues('')).toEqual([]);
  });
});
