import type { WorkflowTemplateManifest } from '@vaep/types';

/**
 * First-party Sales workflow templates. Frozen-17 vocabulary only
 * (AI_EMPLOYEE_STEP + TOOL_ACTION), same discipline the Marketing/HR
 * templates follow. The qualification AI_EMPLOYEE_STEP runs with no tools
 * (disableTools:true is unconditional in ai-employee-step.handler.ts — not a
 * template config, just how the node type works) — it can only recommend, not
 * act; every side effect (the sales-team notify, the nurture template send)
 * is an explicit, separately-gated TOOL_ACTION.
 *
 * ## Trigger-data paths: `{{trigger.data.*}}`, not `{{trigger.*}}`
 *
 * An EVENT-triggered run's `trigger` context is the payload
 * `EventNormalizeProcessor` hands `WorkflowsService.fireEvent`, which for the
 * canonical pipeline is exactly `{ eventId, subject, data }` — `data` being the
 * mapper's `CanonicalMapping.data`. `WorkflowEngineService` puts that object on
 * the run as `trigger`, so the WhatsApp fields the mapper produced (`phone`,
 * `body`, `messageSid`, `leadId`) live one level down under `data`.
 *
 * This template originally referenced the flat `{{trigger.body}}` /
 * `{{trigger.phone}}` / `{{trigger.leadId}}`, which resolve to nothing: the
 * qualification step would have been handed a literal unresolved string and
 * the nurture send would have been called with no lead. (The Gmail/IMAP inbound
 * services flatten their payloads to the top level as well as nesting them,
 * which is where the flat form came from — but the canonical webhook pipeline
 * this template triggers on does not.)
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
        { id: 'qualify', type: 'AI_EMPLOYEE_STEP', name: 'Qualify the lead', config: { employeeId: '{{param.salesEmployee}}', instruction: 'A new WhatsApp lead sent: "{{trigger.data.body}}". Assess budget, need and timeline from this message. Output a JSON object {"hot": true|false, "reason": string}.', outputKey: 'qualification' } },
        { id: 'isHot', type: 'CONDITION', name: 'Hot lead?', config: { left: '{{qualification.hot}}', op: 'eq', right: 'true' } },
        // I5: nothing wrote `Lead.status`, so a lead the AI had just decided was
        // hot still read `NEW` on the Leads screen. This is the one lead
        // mutation the workflow performs, and it runs BEFORE the human notify so
        // that whoever opens the lead from that message already sees QUALIFIED.
        { id: 'markQualified', type: 'TOOL_ACTION', name: 'Mark the lead qualified', config: { skillKey: 'whatsapp', tool: 'update_lead_status', args: { leadId: '{{trigger.data.leadId}}', status: 'QUALIFIED' } } },
        { id: 'notifySales', type: 'TOOL_ACTION', name: 'Notify the sales team', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Hot WhatsApp lead: {{trigger.data.phone}} — {{qualification.reason}}' } } },
        { id: 'nurture', type: 'TOOL_ACTION', name: 'Send nurture follow-up', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.data.leadId}}', templateId: '{{param.nurtureTemplateId}}' } } },
        { id: 'doneHot', type: 'TERMINATE', name: 'Hot lead handed to sales', config: { status: 'COMPLETED', reason: 'Sales team notified.' } },
        { id: 'doneNurture', type: 'TERMINATE', name: 'Nurture sent', config: { status: 'COMPLETED', reason: 'Nurture follow-up sent.' } },
      ],
      edges: [
        { from: 'trigger', to: 'qualify' },
        { from: 'qualify', to: 'isHot' },
        { from: 'isHot', to: 'markQualified', branch: 'true' },
        { from: 'isHot', to: 'nurture', branch: 'false' },
        { from: 'markQualified', to: 'notifySales' },
        { from: 'notifySales', to: 'doneHot' },
        { from: 'nurture', to: 'doneNurture' },
      ],
    },
  },
  {
    key: 'realestate.whatsapp-lead-qualify',
    version: 1,
    name: 'Real Estate: WhatsApp lead qualification',
    description:
      'A Sales AI Employee qualifies an inbound WhatsApp property enquiry (budget/location/property-type). If interested and a preferred visit time was given, it books the site visit and notifies the agent; if interested with no time given, it asks for one; otherwise it sends a nurture follow-up.',
    category: 'SALES',
    parameters: [
      { key: 'salesEmployee', label: 'Sales AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role SALES) that qualifies the lead.' },
      { key: 'nurtureTemplateId', label: 'Nurture template (Twilio Content SID)', type: 'string', required: true, help: 'Pre-approved WhatsApp template to send a lead that is not yet hot.' },
      { key: 'askTimeTemplateId', label: 'Ask-for-a-time template (Twilio Content SID)', type: 'string', required: true, help: 'Pre-approved WhatsApp template asking an interested lead for their preferred site-visit day/time.' },
    ],
    requires: { skills: ['whatsapp', 'calendar', 'leads', 'slack'], employeeRoles: ['SALES'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New WhatsApp property enquiry', config: {} },
        { id: 'qualify', type: 'AI_EMPLOYEE_STEP', name: 'Qualify the enquiry', config: { employeeId: '{{param.salesEmployee}}', instruction: 'A new WhatsApp property enquiry: "{{trigger.data.body}}". Assess budget, preferred location and property type from this message. If the message also states a preferred site-visit day/time, extract it as a plain ISO-ish string (e.g. "2026-09-15T10:00:00"); if none was stated, use an empty string. Output a JSON object {"interested": true|false, "reason": string, "preferredTime": string}.', outputKey: 'qualification' } },
        { id: 'isInterested', type: 'CONDITION', name: 'Interested?', config: { left: '{{qualification.interested}}', op: 'eq', right: 'true' } },
        { id: 'hasTime', type: 'CONDITION', name: 'Preferred time given?', config: { left: '{{qualification.preferredTime}}', op: 'neq', right: '' } },
        { id: 'bookVisit', type: 'TOOL_ACTION', name: 'Book the site visit', config: { skillKey: 'calendar', tool: 'create_event', args: { title: 'Property site visit — {{trigger.data.phone}}', start: '{{qualification.preferredTime}}' }, outputKey: 'visitEvent' } },
        { id: 'recordVisit', type: 'TOOL_ACTION', name: 'Link the visit to the lead', config: { skillKey: 'leads', tool: 'record_site_visit', args: { leadId: '{{trigger.data.leadId}}', eventId: '{{visitEvent.result.id}}', start: '{{qualification.preferredTime}}' } } },
        { id: 'markQualifiedWithVisit', type: 'TOOL_ACTION', name: 'Mark the lead qualified', config: { skillKey: 'whatsapp', tool: 'update_lead_status', args: { leadId: '{{trigger.data.leadId}}', status: 'QUALIFIED' } } },
        { id: 'notifyAgentVisit', type: 'TOOL_ACTION', name: 'Notify the agent — visit booked', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Site visit booked for {{trigger.data.phone}}: {{qualification.reason}}' } } },
        { id: 'askTime', type: 'TOOL_ACTION', name: 'Ask for a preferred time', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.data.leadId}}', templateId: '{{param.askTimeTemplateId}}' } } },
        { id: 'notifyAgentFollowUp', type: 'TOOL_ACTION', name: 'Notify the agent — follow up', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Interested lead, no time yet: {{trigger.data.phone}} — {{qualification.reason}}' } } },
        { id: 'nurture', type: 'TOOL_ACTION', name: 'Send nurture follow-up', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.data.leadId}}', templateId: '{{param.nurtureTemplateId}}' } } },
        { id: 'doneVisit', type: 'TERMINATE', name: 'Visit booked', config: { status: 'COMPLETED', reason: 'Site visit booked and agent notified.' } },
        { id: 'doneAskTime', type: 'TERMINATE', name: 'Asked for a time', config: { status: 'COMPLETED', reason: 'Asked the lead for a preferred visit time; agent notified to follow up.' } },
        { id: 'doneNurture', type: 'TERMINATE', name: 'Nurture sent', config: { status: 'COMPLETED', reason: 'Nurture follow-up sent.' } },
      ],
      edges: [
        { from: 'trigger', to: 'qualify' },
        { from: 'qualify', to: 'isInterested' },
        { from: 'isInterested', to: 'hasTime', branch: 'true' },
        { from: 'isInterested', to: 'nurture', branch: 'false' },
        { from: 'hasTime', to: 'bookVisit', branch: 'true' },
        { from: 'hasTime', to: 'askTime', branch: 'false' },
        { from: 'bookVisit', to: 'recordVisit' },
        { from: 'recordVisit', to: 'markQualifiedWithVisit' },
        { from: 'markQualifiedWithVisit', to: 'notifyAgentVisit' },
        { from: 'notifyAgentVisit', to: 'doneVisit' },
        { from: 'askTime', to: 'notifyAgentFollowUp' },
        { from: 'notifyAgentFollowUp', to: 'doneAskTime' },
        { from: 'nurture', to: 'doneNurture' },
      ],
    },
  },
];
