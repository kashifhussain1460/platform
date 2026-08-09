import type { WorkflowTemplateManifest } from '@vaep/types';

/**
 * First-party Marketing workflow templates (Wave P3-04), reverse-engineered from
 * doc `28-marketing-employee-workflows.md`. Frozen-17 vocabulary only. Social
 * scheduling/publishing use postiz `schedule_post`/`publish_now`, which are
 * highRisk — the engine auto-gates them for approval even without an explicit
 * APPROVAL node. MK-05 checks `get_post_status` BEFORE `publish_now` so a retry
 * can never double-post. All validated by validateManifest on boot +
 * `workflow-templates.catalog.spec.ts`.
 */
export const MARKETING_WORKFLOW_TEMPLATES: readonly WorkflowTemplateManifest[] = [
  {
    key: 'mkt.campaign-plan',
    version: 1,
    name: 'Marketing: campaign plan → approval → save',
    description:
      'A Marketing AI Employee drafts a campaign plan, a marketing lead approves it, then the approved plan is saved to Google Drive.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING) that drafts the plan.' },
    ],
    requires: { skills: ['gdrive'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Campaign planning requested', config: {} },
        { id: 'retrieve', type: 'RETRIEVE', name: 'Brand + past campaigns', config: { query: 'brand guidelines and past campaign retrospectives for {{trigger.brief}}', k: 5, outputKey: 'context' } },
        { id: 'draft', type: 'AI_EMPLOYEE_STEP', name: 'Draft the campaign plan', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Draft a campaign plan for {{trigger.brief}}: objectives, target audience, channel mix, a content calendar and KPI targets. Ground it in the retrieved brand guidelines and past retrospectives {{context}}.', outputKey: 'plan' } },
        { id: 'approval', type: 'APPROVAL', name: 'Marketing lead approves the plan', config: { message: 'Review the campaign plan (objectives, audience, channel mix, budget and KPIs) before any content work begins.' } },
        { id: 'save', type: 'TOOL_ACTION', name: 'Save the plan to Drive', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Campaign Plan — {{trigger.campaignName}}.md', content: '{{plan}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Plan saved', config: { status: 'COMPLETED', reason: 'Campaign plan approved and saved.' } },
      ],
      edges: [
        { from: 'trigger', to: 'retrieve' },
        { from: 'retrieve', to: 'draft' },
        { from: 'draft', to: 'approval' },
        { from: 'approval', to: 'save' },
        { from: 'save', to: 'done' },
      ],
    },
  },
  {
    key: 'mkt.content-generate',
    version: 1,
    name: 'Marketing: generate content drafts',
    description:
      'A Marketing AI Employee generates channel-ready content drafts and saves them to Google Drive for later review. No approval here — approval happens in the content-approval workflow before anything is published.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING) that drafts the content.' },
    ],
    requires: { skills: ['gdrive'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Campaign approved / content requested', config: {} },
        { id: 'retrieve', type: 'RETRIEVE', name: 'Brand voice + product facts', config: { query: 'brand voice guide, tone rules and approved product facts', k: 5, outputKey: 'brand' } },
        { id: 'generate', type: 'AI_EMPLOYEE_STEP', name: 'Generate the drafts', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Generate channel-appropriate content drafts for campaign {{trigger.campaignId}} on {{trigger.channel}} using the brand guide {{brand}}. Follow the brand voice and the per-channel length limits. Draft only — never state a product claim that is not in the retrieved facts.', outputKey: 'drafts' } },
        { id: 'save', type: 'TOOL_ACTION', name: 'Save the drafts to Drive', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Content Drafts — {{trigger.campaignId}}.md', content: '{{drafts}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Drafts saved', config: { status: 'COMPLETED', reason: 'Drafts generated and saved for review.' } },
      ],
      edges: [
        { from: 'trigger', to: 'retrieve' },
        { from: 'retrieve', to: 'generate' },
        { from: 'generate', to: 'save' },
        { from: 'save', to: 'done' },
      ],
    },
  },
  {
    key: 'mkt.content-approval',
    version: 1,
    name: 'Marketing: content draft → approval → schedule',
    description:
      'A Marketing AI Employee drafts a social post, a human approves it, then it is scheduled.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING).' },
    ],
    requires: { skills: ['postiz'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Content request', config: {} },
        { id: 'draft', type: 'AI_EMPLOYEE_STEP', name: 'Draft the post', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Draft a social post for {{trigger.brief}}, under 280 chars.', outputKey: 'post' } },
        { id: 'approval', type: 'APPROVAL', name: 'Approve the post', config: { message: 'Review the drafted post before it is scheduled.' } },
        { id: 'schedule', type: 'TOOL_ACTION', name: 'Schedule it', config: { skillKey: 'postiz', tool: 'schedule_post', args: { content: '{{post}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'draft' },
        { from: 'draft', to: 'approval' },
        { from: 'approval', to: 'schedule' },
      ],
    },
  },
  {
    key: 'mkt.social-schedule',
    version: 1,
    name: 'Marketing: schedule an approved post',
    description:
      'A Marketing AI Employee finalises an approved post and schedules it. Scheduling is highRisk, so the platform automatically pauses the run for human approval before anything is queued.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING) that finalises the post.' },
    ],
    requires: { skills: ['postiz'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Content approved', config: {} },
        { id: 'accounts', type: 'TOOL_ACTION', name: 'List connected accounts', config: { skillKey: 'postiz', tool: 'list_connected_accounts', args: {}, outputKey: 'accounts' } },
        { id: 'finalise', type: 'AI_EMPLOYEE_STEP', name: 'Finalise the post + slot', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Finalise approved content {{trigger.approvedContentId}} for {{trigger.channel}} using the connected accounts {{accounts}}: apply channel formatting, confirm it is within limits, and pick an optimal posting slot. Do not change the approved message.', outputKey: 'finalPost' } },
        { id: 'schedule', type: 'TOOL_ACTION', name: 'Schedule the post', config: { skillKey: 'postiz', tool: 'schedule_post', args: { socialAccountId: '{{trigger.socialAccountId}}', content: '{{finalPost}}', publishAt: '{{trigger.publishAt}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Scheduled', config: { status: 'COMPLETED', reason: 'Post scheduled (subject to the platform publish gate).' } },
      ],
      edges: [
        { from: 'trigger', to: 'accounts' },
        { from: 'accounts', to: 'finalise' },
        { from: 'finalise', to: 'schedule' },
        { from: 'schedule', to: 'done' },
      ],
    },
  },
  {
    key: 'mkt.social-publish',
    version: 1,
    name: 'Marketing: publish (double-post safe)',
    description:
      'Before publishing, the workflow checks the post status. If it was already published it stops, so a retry can never double-post. Otherwise a Marketing AI Employee formats the post and it is published (highRisk, so the platform gates it for approval).',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING) that formats the post.' },
    ],
    requires: { skills: ['postiz'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Scheduled time / publish-now', config: {} },
        { id: 'checkStatus', type: 'TOOL_ACTION', name: 'Check post status first', config: { skillKey: 'postiz', tool: 'get_post_status', args: { scheduledPostId: '{{trigger.scheduledPostId}}' }, outputKey: 'statusCheck' } },
        { id: 'alreadyPublished', type: 'CONDITION', name: 'Already published?', config: { left: '{{statusCheck.result.status}}', op: 'eq', right: 'PUBLISHED' } },
        { id: 'skip', type: 'TERMINATE', name: 'Skip — already published', config: { status: 'COMPLETED', reason: 'Post already published — skipped to prevent a double-post.' } },
        { id: 'finalise', type: 'AI_EMPLOYEE_STEP', name: 'Format for the channel', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Apply channel-specific formatting to the approved post {{trigger.content}} for {{trigger.channel}}. Do not change the approved message.', outputKey: 'finalPost' } },
        { id: 'publish', type: 'TOOL_ACTION', name: 'Publish now', config: { skillKey: 'postiz', tool: 'publish_now', args: { socialAccountId: '{{trigger.socialAccountId}}', content: '{{finalPost}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Published', config: { status: 'COMPLETED', reason: 'Post published.' } },
      ],
      edges: [
        { from: 'trigger', to: 'checkStatus' },
        { from: 'checkStatus', to: 'alreadyPublished' },
        { from: 'alreadyPublished', to: 'skip', branch: 'true' },
        { from: 'alreadyPublished', to: 'finalise', branch: 'false' },
        { from: 'finalise', to: 'publish' },
        { from: 'publish', to: 'done' },
      ],
    },
  },
  {
    key: 'mkt.email-campaign',
    version: 1,
    name: 'Marketing: email campaign → approval → send',
    description:
      'A Marketing AI Employee drafts an email campaign. Consent must be verified first, and a human must approve both the content and the recipient volume, before it is sent.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING) that drafts the campaign.' },
    ],
    requires: { skills: ['gmail'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Email campaign requested', config: {} },
        { id: 'retrieve', type: 'RETRIEVE', name: 'Email policy + consent rules', config: { query: 'email policy, consent and unsubscribe rules, and brand voice', k: 5, outputKey: 'policy' } },
        { id: 'draft', type: 'AI_EMPLOYEE_STEP', name: 'Draft the email', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Draft an email campaign for {{trigger.campaignId}} targeting segment {{trigger.segmentQuery}} using the policy {{policy}}: a subject line and body in brand voice with an unsubscribe footer. Exclude anyone on the suppression list.', outputKey: 'email' } },
        { id: 'consent', type: 'CONDITION', name: 'Consent verified?', config: { left: '{{trigger.consentVerified}}', op: 'eq', right: 'true' } },
        { id: 'blocked', type: 'TERMINATE', name: 'Blocked — no consent', config: { status: 'FAILED', reason: 'Consent not verified / suppression not applied — send blocked.' } },
        { id: 'approval', type: 'APPROVAL', name: 'Approve content + volume', config: { message: 'Approve BOTH the email content and the recipient volume ({{trigger.recipientCount}} recipients) before this campaign is sent.' } },
        { id: 'send', type: 'TOOL_ACTION', name: 'Send the campaign', config: { skillKey: 'gmail', tool: 'send_email', args: { to: '{{trigger.recipients}}', subject: '{{trigger.subject}}', body: '{{email}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Sent', config: { status: 'COMPLETED', reason: 'Email campaign approved and sent.' } },
      ],
      edges: [
        { from: 'trigger', to: 'retrieve' },
        { from: 'retrieve', to: 'draft' },
        { from: 'draft', to: 'consent' },
        { from: 'consent', to: 'blocked', branch: 'false' },
        { from: 'consent', to: 'approval', branch: 'true' },
        { from: 'approval', to: 'send' },
        { from: 'send', to: 'done' },
      ],
    },
  },
  {
    key: 'mkt.seo-content',
    version: 1,
    name: 'Marketing: SEO content draft',
    description:
      'On a schedule or on demand, a Marketing AI Employee researches a keyword brief and drafts SEO-optimised content; an editor approves it; then the draft is saved to Google Drive. Draft only — nothing is published.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role MARKETING) that researches and drafts the content.' },
    ],
    requires: { skills: ['http', 'gdrive'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Scheduled SEO content run', config: {} },
        { id: 'research', type: 'TOOL_ACTION', name: 'Pull keyword data', config: { skillKey: 'http', tool: 'request', args: { method: 'GET', url: '{{trigger.seoEndpoint}}' }, outputKey: 'keywordData' } },
        { id: 'draft', type: 'AI_EMPLOYEE_STEP', name: 'Draft SEO content', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Research the keyword brief in {{trigger.brief}} using the keyword data in {{keywordData}}, then draft SEO-optimised long-form content with a meta description and internal-link suggestions. Draft only — do not publish, and state any claim you cannot ground.', outputKey: 'article' } },
        { id: 'approval', type: 'APPROVAL', name: 'Editor approves the draft', config: { message: 'Review the SEO draft and meta description before it is saved for publication.' } },
        { id: 'save', type: 'TOOL_ACTION', name: 'Save the approved draft', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'SEO draft — {{trigger.brief}}', content: '{{article}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'research' },
        { from: 'research', to: 'draft' },
        { from: 'draft', to: 'approval' },
        { from: 'approval', to: 'save' },
      ],
    },
  },
  {
    key: 'mkt.lead-capture',
    version: 1,
    name: 'Marketing: inbound lead capture',
    description:
      'On an inbound lead (webhook/event), a Marketing AI Employee qualifies and scores it, records it in the CRM, then a human approves before any outbound message is sent to the prospect. The AI qualifies and routes — it does not sell.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role MARKETING) that qualifies and drafts the outreach.' },
    ],
    requires: { skills: ['hubspot', 'gmail'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Inbound lead received', config: {} },
        { id: 'qualify', type: 'AI_EMPLOYEE_STEP', name: 'Qualify the lead', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Qualify the inbound lead in {{trigger.payload}} against the ICP: enrich, score, and recommend a routing owner, then draft a short, personalised first-touch outreach email. Do not contact the prospect.', outputKey: 'outreach' } },
        { id: 'crm', type: 'TOOL_ACTION', name: 'Create/update the CRM contact', config: { skillKey: 'hubspot', tool: 'create_contact', args: { email: '{{trigger.email}}', name: '{{trigger.name}}' } } },
        { id: 'approval', type: 'APPROVAL', name: 'Approve outreach', config: { message: 'Review the lead qualification and approve the drafted outreach before it is sent to the prospect.' } },
        { id: 'send', type: 'TOOL_ACTION', name: 'Send the approved outreach', config: { skillKey: 'gmail', tool: 'send_email', args: { to: '{{trigger.email}}', subject: 'Thanks for reaching out', body: '{{outreach}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'qualify' },
        { from: 'qualify', to: 'crm' },
        { from: 'crm', to: 'approval' },
        { from: 'approval', to: 'send' },
      ],
    },
  },
  {
    key: 'mkt.campaign-monitor',
    version: 1,
    name: 'Marketing: campaign monitor',
    description:
      'On a schedule, a Marketing AI Employee pulls campaign metrics, flags any anomalies against the KPI targets, and posts a status summary to a channel. Read-only — it observes and recommends, never changes spend or content.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role MARKETING) that reviews performance.' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel the status summary is posted to.' },
    ],
    requires: { skills: ['postiz', 'slack'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Scheduled campaign check', config: {} },
        { id: 'metrics', type: 'TOOL_ACTION', name: 'Pull post metrics', config: { skillKey: 'postiz', tool: 'get_post_status', args: { scheduledPostId: '{{trigger.scheduledPostId}}' }, outputKey: 'metrics' } },
        { id: 'summarise', type: 'AI_EMPLOYEE_STEP', name: 'Summarise performance', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Review the campaign metrics in {{metrics}} against the KPI targets, flag any anomalies, and write a short status summary. Recommend only — never change spend or content. If metrics are unavailable, report the gap.', outputKey: 'summary' } },
        { id: 'post', type: 'TOOL_ACTION', name: 'Post the status summary', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: '{{summary}}' } } },
        { id: 'snapshot', type: 'MEMORY_WRITE', name: 'Record the snapshot', config: { employeeId: '{{param.marketingEmployee}}', content: '{{summary}}' } },
      ],
      edges: [
        { from: 'trigger', to: 'metrics' },
        { from: 'metrics', to: 'summarise' },
        { from: 'summarise', to: 'post' },
        { from: 'post', to: 'snapshot' },
      ],
    },
  },
  {
    key: 'mkt.analytics-report',
    version: 1,
    name: 'Marketing: analytics report',
    description:
      'On a schedule, a Marketing AI Employee compiles a marketing analytics report, saves it to Google Drive, and posts the summary to an internal channel. Internal distribution only — every figure traces to real data.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role MARKETING) that compiles and narrates the report.' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Internal Slack channel the report summary is posted to.' },
    ],
    requires: { skills: ['postiz', 'gdrive', 'slack'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Scheduled analytics report', config: {} },
        { id: 'metrics', type: 'TOOL_ACTION', name: 'Pull campaign metrics', config: { skillKey: 'postiz', tool: 'get_post_status', args: { scheduledPostId: '{{trigger.scheduledPostId}}' }, outputKey: 'metrics' } },
        { id: 'compile', type: 'AI_EMPLOYEE_STEP', name: 'Compile the report', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Compile a marketing analytics report for {{trigger.period}} from the metrics in {{metrics}}: attribute results, narrate honestly, and state any gaps in the data. Never invent a number — report unavailable metrics as unavailable.', outputKey: 'report' } },
        { id: 'save', type: 'TOOL_ACTION', name: 'Save the report to Drive', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Marketing analytics report — {{trigger.period}}', content: '{{report}}' } } },
        { id: 'post', type: 'TOOL_ACTION', name: 'Post the summary internally', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: '{{report}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'metrics' },
        { from: 'metrics', to: 'compile' },
        { from: 'compile', to: 'save' },
        { from: 'save', to: 'post' },
      ],
    },
  },
  {
    key: 'mkt.brand-audit',
    version: 1,
    name: 'Marketing: brand compliance audit',
    description:
      'On a schedule, a Marketing AI Employee reviews published assets, collects brand violations, then one approval authorises takedowns.',
    category: 'MARKETING',
    parameters: [
      { key: 'marketingEmployee', label: 'Marketing AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role MARKETING).' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel for the report.' },
    ],
    requires: { skills: ['postiz', 'slack'], employeeRoles: ['MARKETING'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Scheduled audit', config: {} },
        { id: 'review', type: 'AI_EMPLOYEE_STEP', name: 'Review assets for violations', config: { employeeId: '{{param.marketingEmployee}}', instruction: 'Review recent published posts and list brand-guideline violations.', outputKey: 'violations' } },
        { id: 'approval', type: 'APPROVAL', name: 'Approve takedowns', config: { message: 'Review the brand violations and approve any takedowns.' } },
        { id: 'report', type: 'TOOL_ACTION', name: 'Post the report', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: '{{violations}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'review' },
        { from: 'review', to: 'approval' },
        { from: 'approval', to: 'report' },
      ],
    },
  },
];
