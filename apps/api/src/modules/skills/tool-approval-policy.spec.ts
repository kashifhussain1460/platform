import {
  contextHasUnresolvedValidationConcern,
  extractValidationConcern,
  isExternalActionTool,
  toolRequiresApproval,
  validationContextKey,
} from './tool-approval-policy';

describe('toolRequiresApproval', () => {
  it('is true for a catalog highRisk tool regardless of employee rules', () => {
    expect(toolRequiresApproval(null, 'postiz', 'publish_now')).toBe(true);
  });

  it('is true for a Chatwoot customer-facing tool after S-04', () => {
    expect(toolRequiresApproval(null, 'chatwoot', 'reply_to_conversation')).toBe(true);
    expect(toolRequiresApproval(null, 'chatwoot', 'resolve_conversation')).toBe(true);
  });

  it('is false for a non-highRisk tool with no employee rules', () => {
    expect(toolRequiresApproval(null, 'chatwoot', 'list_open_conversations')).toBe(false);
  });

  it('is true when the employee requires approval for all tools', () => {
    const employee = { approvalRules: { requireApprovalForAllTools: true } };
    expect(toolRequiresApproval(employee, 'chatwoot', 'list_open_conversations')).toBe(true);
  });
});

describe('isExternalActionTool', () => {
  it('lists both Chatwoot mutating tools', () => {
    expect(isExternalActionTool('chatwoot', 'reply_to_conversation')).toBe(true);
    expect(isExternalActionTool('chatwoot', 'resolve_conversation')).toBe(true);
  });

  it('excludes read-only tools', () => {
    expect(isExternalActionTool('chatwoot', 'list_open_conversations')).toBe(false);
  });
});

describe('S-01 validation-context signal', () => {
  it('extractValidationConcern reads needsApproval from a node output shape', () => {
    expect(extractValidationConcern({ validation: { needsApproval: true } })).toBe(true);
    expect(extractValidationConcern({ validation: { needsApproval: false } })).toBe(false);
  });

  it('extractValidationConcern is false for missing/malformed shapes', () => {
    expect(extractValidationConcern(undefined)).toBe(false);
    expect(extractValidationConcern(null)).toBe(false);
    expect(extractValidationConcern('not an object')).toBe(false);
    expect(extractValidationConcern({})).toBe(false);
    expect(extractValidationConcern({ validation: 'nope' })).toBe(false);
  });

  it('contextHasUnresolvedValidationConcern is false for an empty/undefined context', () => {
    expect(contextHasUnresolvedValidationConcern(undefined)).toBe(false);
    expect(contextHasUnresolvedValidationConcern(null)).toBe(false);
    expect(contextHasUnresolvedValidationConcern({})).toBe(false);
  });

  it('contextHasUnresolvedValidationConcern is true once a node wrote a concern', () => {
    const context = { [validationContextKey('node_1')]: true };
    expect(contextHasUnresolvedValidationConcern(context)).toBe(true);
  });

  it('ignores an unrelated context key that merely starts with a similar prefix', () => {
    const context = { unrelatedKey: true };
    expect(contextHasUnresolvedValidationConcern(context)).toBe(false);
  });

  it('ignores a validation key explicitly set to false', () => {
    const context = { [validationContextKey('node_1')]: false };
    expect(contextHasUnresolvedValidationConcern(context)).toBe(false);
  });
});

/**
 * Phase 1 — "Require approval for external messages".
 *
 * The Employee Settings panel wrote `approvalRules.approveExternalMessages`
 * from the day the panel shipped, and `toolRequiresApproval` never looked at
 * it. An admin could tick it, save, reload, see it ticked — and the employee
 * would keep emailing customers with no gate. These tests pin the flag to the
 * SAME `isExternalActionTool` set the chat ACT loop already uses.
 */
describe('approveExternalMessages', () => {
  const on = { approvalRules: { approveExternalMessages: true } };
  const off = { approvalRules: { approveExternalMessages: false } };

  it('gates a tool that reaches a person', () => {
    expect(toolRequiresApproval(on, 'gmail', 'send_email')).toBe(true);
    expect(toolRequiresApproval(on, 'slack', 'send_message')).toBe(true);
    expect(toolRequiresApproval(on, 'chatwoot', 'reply_to_conversation')).toBe(true);
  });

  it('gates a tool that mutates an external system or egresses data', () => {
    expect(toolRequiresApproval(on, 'http', 'request')).toBe(true);
    expect(toolRequiresApproval(on, 'gdrive', 'upload_file')).toBe(true);
  });

  it('leaves read-only tools ungated, so the agent can still gather context', () => {
    expect(toolRequiresApproval(on, 'gdrive', 'list_files')).toBe(false);
    expect(toolRequiresApproval(on, 'jira', 'list_issues')).toBe(false);
    expect(toolRequiresApproval(on, 'stripe', 'get_balance')).toBe(false);
  });

  it('changes nothing when the flag is off or absent', () => {
    expect(toolRequiresApproval(off, 'gmail', 'send_email')).toBe(false);
    expect(toolRequiresApproval({}, 'gmail', 'send_email')).toBe(false);
    expect(toolRequiresApproval(null, 'gmail', 'send_email')).toBe(false);
  });

  it('never LOWERS an existing gate — highRisk still wins', () => {
    // stripe.create_payment_link is catalog-highRisk; turning the flag off must
    // not become a way to switch that off.
    expect(toolRequiresApproval(off, 'stripe', 'create_payment_link')).toBe(true);
  });

  it('composes with requireApprovalForTools rather than replacing it', () => {
    const both = {
      approvalRules: {
        approveExternalMessages: true,
        requireApprovalForTools: ['gdrive:list_files'],
      },
    };
    expect(toolRequiresApproval(both, 'gmail', 'send_email')).toBe(true);
    expect(toolRequiresApproval(both, 'gdrive', 'list_files')).toBe(true);
  });
});
