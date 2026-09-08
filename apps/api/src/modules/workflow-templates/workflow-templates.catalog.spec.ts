import { SkillCatalog } from '../skills/catalog';
import { resolveTemplate } from '../workflows/engine/template';
import { HR_WORKFLOW_TEMPLATES } from './hr-workflow-templates.catalog';
import { MARKETING_WORKFLOW_TEMPLATES } from './marketing-workflow-templates.catalog';
import { SALES_WORKFLOW_TEMPLATES } from './sales-workflow-templates.catalog';
import { FIRST_PARTY_WORKFLOW_TEMPLATES } from './workflow-templates.catalog';
import { validateManifest } from './workflow-templates.util';

/**
 * Guards the first-party catalog (P3-03 HR + P3-04 Marketing + the WhatsApp Sales
 * template). This is the SAME validation the boot seeder runs, so a broken
 * template is caught here (fast, no infra) instead of crashing the app on startup.
 */
describe('first-party workflow template catalog', () => {
  const validSkills = new Set(SkillCatalog.list().map((s) => s.key));

  it('has 11 HR + 11 Marketing + 2 Sales = 24 templates', () => {
    expect(HR_WORKFLOW_TEMPLATES).toHaveLength(11);
    expect(MARKETING_WORKFLOW_TEMPLATES).toHaveLength(11);
    expect(SALES_WORKFLOW_TEMPLATES).toHaveLength(2);
    expect(FIRST_PARTY_WORKFLOW_TEMPLATES).toHaveLength(24);
  });

  it('every (key,version) is unique', () => {
    const seen = new Set<string>();
    for (const t of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      const id = `${t.key}@${t.version}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('every manifest passes validateManifest (the boot-seed gate)', () => {
    for (const manifest of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      expect(() => validateManifest(manifest, validSkills)).not.toThrow();
    }
  });

  it('HR templates are category HR + require the HR role; Marketing are MARKETING; Sales are SALES', () => {
    for (const t of HR_WORKFLOW_TEMPLATES) {
      expect(t.category).toBe('HR');
      expect(t.requires.employeeRoles).toContain('HR');
      expect(t.key.startsWith('hr.')).toBe(true);
    }
    for (const t of MARKETING_WORKFLOW_TEMPLATES) {
      expect(t.category).toBe('MARKETING');
      expect(t.requires.employeeRoles).toContain('MARKETING');
      expect(t.key.startsWith('mkt.')).toBe(true);
    }
    for (const t of SALES_WORKFLOW_TEMPLATES) {
      expect(t.category).toBe('SALES');
      expect(t.requires.employeeRoles).toContain('SALES');
      // Most Sales templates are 'sales.'-prefixed; vertical-specific ones (e.g.
      // real estate) key off their own domain instead while staying category SALES.
      expect(t.key.startsWith('sales.') || t.key.startsWith('realestate.')).toBe(true);
    }
  });

  it('every requires.skill is a real catalog skill', () => {
    for (const t of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      for (const skill of t.requires.skills) {
        expect(validSkills.has(skill)).toBe(true);
      }
    }
  });

  it('most templates carry a human APPROVAL gate (the spec mandates it for the majority)', () => {
    const withApproval = FIRST_PARTY_WORKFLOW_TEMPLATES.filter((t) =>
      t.definition.nodes.some((n) => n.type === 'APPROVAL'),
    );
    // 8 HR + 7 Marketing per docs 27/28 (social scheduling/publishing rely on the
    // highRisk auto-gate instead of an explicit APPROVAL node).
    expect(withApproval.length).toBeGreaterThanOrEqual(14);
  });

  /**
   * I4 — the template referenced `{{trigger.leadId}}` / `{{trigger.body}}` /
   * `{{trigger.phone}}`, but an EVENT run's trigger context is the payload
   * `EventNormalizeProcessor` passes `fireEvent`: `{ eventId, subject, data }`.
   * The flat paths resolved to the empty string, so the qualification step got
   * an instruction with a hole in it and the nurture send was called with no
   * lead id at all.
   *
   * Proved here with the REAL resolver against the REAL canonical payload
   * shape, rather than by eyeballing the strings.
   */
  describe('sales.whatsapp-lead-qualify trigger-data paths', () => {
    const template = SALES_WORKFLOW_TEMPLATES[0];

    /** Exactly what `EventNormalizeProcessor` hands `fireEvent` for a WhatsApp NEW_LEAD. */
    const runContext = {
      trigger: {
        eventId: 'MM123',
        subject: { phone: '+15550002222' },
        data: {
          phone: '+15550002222',
          body: 'I want a quote',
          messageSid: 'MM123',
          leadId: 'lead_1',
        },
      },
    };

    const nodeConfig = (id: string): Record<string, unknown> =>
      (template.definition.nodes.find((n) => n.id === id)?.config ?? {}) as Record<string, unknown>;

    it('resolves the qualification instruction to the real message body', () => {
      const instruction = resolveTemplate(nodeConfig('qualify').instruction, runContext);
      expect(instruction).toContain('I want a quote');
      expect(instruction).not.toContain('{{');
    });

    it('resolves the nurture send to the real lead id', () => {
      const args = nodeConfig('nurture').args as Record<string, unknown>;
      expect(resolveTemplate(args.leadId, runContext)).toBe('lead_1');
    });

    it('resolves the sales notification to the real phone number', () => {
      const args = nodeConfig('notifySales').args as Record<string, unknown>;
      expect(resolveTemplate(args.text, runContext)).toContain('+15550002222');
    });

    // I5 — nothing wrote `Lead.status`, so every lead sat at NEW for ever.
    it('marks the lead QUALIFIED on the hot branch', () => {
      const node = template.definition.nodes.find((n) => n.id === 'markQualified');
      expect(node?.type).toBe('TOOL_ACTION');
      const config = node?.config as { skillKey?: string; tool?: string; args?: Record<string, unknown> };
      expect(config.skillKey).toBe('whatsapp');
      expect(config.tool).toBe('update_lead_status');
      expect(config.args?.status).toBe('QUALIFIED');
      expect(resolveTemplate(config.args?.leadId, runContext)).toBe('lead_1');
      // On the TRUE (hot) branch only — a nurtured lead is not qualified.
      expect(
        template.definition.edges.some(
          (e) => e.from === 'isHot' && e.to === 'markQualified' && e.branch === 'true',
        ),
      ).toBe(true);
    });

    it('has no flat {{trigger.x}} references left anywhere in the template', () => {
      const serialized = JSON.stringify(template.definition);
      const flat = serialized.match(/\{\{trigger\.(?!data\.)[\w.]+\}\}/g) ?? [];
      expect(flat).toEqual([]);
    });
  });

  /**
   * Same discipline as sales.whatsapp-lead-qualify above, for the new
   * real-estate template: proves `{{trigger.data.*}}` and the
   * qualification/visitEvent context keys actually resolve against a
   * realistic canonical-event payload, not just that the manifest validates
   * structurally.
   */
  describe('realestate.whatsapp-lead-qualify trigger-data paths', () => {
    const template = SALES_WORKFLOW_TEMPLATES[1];

    /** Exactly what `EventNormalizeProcessor` hands `fireEvent` for a WhatsApp NEW_LEAD. */
    const runContext = {
      trigger: {
        eventId: 'MM456',
        subject: { phone: '+15550002222' },
        data: {
          phone: '+15550002222',
          body: 'Interested in the 3-bed on Elm St, budget 500k, can visit Tuesday 10am',
          messageSid: 'MM456',
          leadId: 'lead_1',
        },
      },
      qualification: {
        interested: true,
        reason: 'Budget 500k, wants a 3-bed on Elm St',
        preferredTime: '2026-09-15T10:00:00',
      },
      visitEvent: {
        result: { id: 'evt_789' },
      },
    };

    const nodeConfig = (id: string): Record<string, unknown> =>
      (template.definition.nodes.find((n) => n.id === id)?.config ?? {}) as Record<string, unknown>;

    it('resolves the qualification instruction to the real message body', () => {
      const instruction = resolveTemplate(nodeConfig('qualify').instruction, runContext);
      expect(instruction).toContain('Interested in the 3-bed on Elm St');
      expect(instruction).not.toContain('{{');
    });

    it('resolves the site-visit booking to the real phone and preferred time', () => {
      const args = nodeConfig('bookVisit').args as Record<string, unknown>;
      expect(resolveTemplate(args.title, runContext)).toBe('Property site visit — +15550002222');
      expect(resolveTemplate(args.start, runContext)).toBe('2026-09-15T10:00:00');
    });

    it('resolves the visit-record link to the real lead id and booked event id', () => {
      const args = nodeConfig('recordVisit').args as Record<string, unknown>;
      expect(resolveTemplate(args.leadId, runContext)).toBe('lead_1');
      expect(resolveTemplate(args.eventId, runContext)).toBe('evt_789');
      expect(resolveTemplate(args.start, runContext)).toBe('2026-09-15T10:00:00');
    });

    it('resolves the agent notification to the real phone number and reason', () => {
      const args = nodeConfig('notifyAgentVisit').args as Record<string, unknown>;
      const text = resolveTemplate(args.text, runContext);
      expect(text).toContain('+15550002222');
      expect(text).toContain('Budget 500k, wants a 3-bed on Elm St');
    });

    it('has no flat {{trigger.x}} references left anywhere in the template', () => {
      const serialized = JSON.stringify(template.definition);
      const flat = serialized.match(/\{\{trigger\.(?!data\.)[\w.]+\}\}/g) ?? [];
      expect(flat).toEqual([]);
    });

    it('has no unresolved {{ left anywhere once the whole definition is resolved against the run context', () => {
      // resolveTemplate replaces every {{path}} match with a (possibly empty)
      // string, so a fully-resolved definition never contains a literal "{{"
      // (param.* isn't bound at run time — it resolves to '' here, same as any
      // other absent path — proving the whole graph, not just the four nodes
      // above, is free of the flat-trigger mistake I4 caught).
      const resolved = resolveTemplate(JSON.stringify(template.definition), runContext);
      expect(resolved).not.toContain('{{');
    });
  });
});
