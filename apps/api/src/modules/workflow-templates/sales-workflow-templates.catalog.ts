import type { WorkflowTemplateManifest } from '@vaep/types';

/**
 * First-party Sales workflow templates. Frozen-17 vocabulary only
 * (AI_EMPLOYEE_STEP + TOOL_ACTION), same discipline the Marketing/HR
 * templates follow. The qualification AI_EMPLOYEE_STEP runs with no tools
 * (disableTools:true is unconditional in ai-employee-step.handler.ts — not a
 * template config, just how the node type works) — it can only recommend, not
 * act; every side effect (the sales-team notify, the nurture template send)
 * is an explicit, separately-gated TOOL_ACTION.
 */
export const SALES_WORKFLOW_TEMPLATES: readonly WorkflowTemplateManifest[] = [
  {
    key: 'sales.whatsapp-lead-qualify',
    version: 1,
    name: 'Sales: WhatsApp lead qualification',
    description:
      'A Sales AI Employee qualifies an inbound WhatsApp lead (budget/need/timeline) and either notifies the sales team for a hot lead or sends a nurture follow-up template.',
    category: 'SALES',
    parameters: [
      { key: 'salesEmployee', label: 'Sales AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role SALES) that qualifies the lead.' },
      { key: 'nurtureTemplateId', label: 'Nurture template (Twilio Content SID)', type: 'string', required: true, help: 'Pre-approved WhatsApp template to send a lead that is not yet hot.' },
    ],
    requires: { skills: ['whatsapp', 'slack'], employeeRoles: ['SALES'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New WhatsApp lead', config: {} },
        { id: 'qualify', type: 'AI_EMPLOYEE_STEP', name: 'Qualify the lead', config: { employeeId: '{{param.salesEmployee}}', instruction: 'A new WhatsApp lead sent: "{{trigger.body}}". Assess budget, need and timeline from this message. Output a JSON object {"hot": true|false, "reason": string}.', outputKey: 'qualification' } },
        { id: 'isHot', type: 'CONDITION', name: 'Hot lead?', config: { left: '{{qualification.hot}}', op: 'eq', right: 'true' } },
        { id: 'notifySales', type: 'TOOL_ACTION', name: 'Notify the sales team', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Hot WhatsApp lead: {{trigger.phone}} — {{qualification.reason}}' } } },
        { id: 'nurture', type: 'TOOL_ACTION', name: 'Send nurture follow-up', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.leadId}}', templateId: '{{param.nurtureTemplateId}}' } } },
        { id: 'doneHot', type: 'TERMINATE', name: 'Hot lead handed to sales', config: { status: 'COMPLETED', reason: 'Sales team notified.' } },
        { id: 'doneNurture', type: 'TERMINATE', name: 'Nurture sent', config: { status: 'COMPLETED', reason: 'Nurture follow-up sent.' } },
      ],
      edges: [
        { from: 'trigger', to: 'qualify' },
        { from: 'qualify', to: 'isHot' },
        { from: 'isHot', to: 'notifySales', branch: 'true' },
        { from: 'isHot', to: 'nurture', branch: 'false' },
        { from: 'notifySales', to: 'doneHot' },
        { from: 'nurture', to: 'doneNurture' },
      ],
    },
  },
];
