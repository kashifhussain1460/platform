import { describe, expect, it } from 'vitest';
import { diverseSample } from './page';
import type { WorkflowTemplateSummaryDto } from '@vaep/types';

function makeTemplate(id: string, category: WorkflowTemplateSummaryDto['category']): WorkflowTemplateSummaryDto {
  return {
    id,
    companyId: null,
    key: id,
    version: 1,
    name: id,
    description: null,
    category,
    parameters: [],
    requires: { skills: [], employeeRoles: [] },
    status: 'PUBLISHED',
    createdAt: '2026-08-20T00:00:00.000Z',
  };
}

describe('diverseSample (gap fix: the default template view must not be one category)', () => {
  it('round-robins across every category instead of taking a category-sorted slice', () => {
    // 9 HR templates (alphabetically first) vs 1 Marketing template — the OLD
    // `.slice(0, 6)` behaviour would show 6 HR templates and zero Marketing.
    const templates = [
      ...Array.from({ length: 9 }, (_, i) => makeTemplate(`hr-${i}`, 'HR')),
      makeTemplate('mkt-0', 'MARKETING'),
    ];

    const sample = diverseSample(templates, 6);

    expect(sample.some((t) => t.category === 'MARKETING')).toBe(true);
  });

  it('never returns more than max, even with many categories', () => {
    const templates = ['HR', 'MARKETING', 'SALES', 'SUPPORT', 'FINANCE', 'IT', 'OPERATIONS'].flatMap(
      (category, i) => [makeTemplate(`${category}-a`, category as WorkflowTemplateSummaryDto['category']), makeTemplate(`${category}-b-${i}`, category as WorkflowTemplateSummaryDto['category'])],
    );
    expect(diverseSample(templates, 6)).toHaveLength(6);
  });

  it('returns everything when there are fewer templates than max', () => {
    const templates = [makeTemplate('a', 'HR'), makeTemplate('b', 'MARKETING')];
    expect(diverseSample(templates, 6)).toHaveLength(2);
  });

  it('never duplicates a template', () => {
    const templates = Array.from({ length: 20 }, (_, i) => makeTemplate(`t-${i}`, 'HR'));
    const sample = diverseSample(templates, 6);
    expect(new Set(sample.map((t) => t.id)).size).toBe(sample.length);
  });
});
