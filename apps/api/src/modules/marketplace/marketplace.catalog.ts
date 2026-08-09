import type {
  EmployeeTemplateDto,
  WorkflowTemplateDto,
} from '@vaep/types';

/**
 * The MARKETPLACE catalog — code, not DB (mirrors the Skills catalog and the
 * onboarding role catalog). This is the single source of truth for the extra
 * AI Employees and Workflow Templates a tenant can install. Skills are NOT
 * duplicated here — the marketplace re-serves the existing SkillCatalog.
 *
 * Installs DELEGATE: an employee template → EmployeesService.create (role +
 * persona + name); a workflow template → WorkflowsService.create (name +
 * description + definition). No new Prisma models.
 *
 * TODO: third-party publisher marketplace + commission billing; template
 * versioning; industry-specific packs.
 */

const EMPLOYEE_TEMPLATES: readonly EmployeeTemplateDto[] = [
  // --- Standard roles (mirror the onboarding role catalog) -----------------
  {
    key: 'recruit-ai',
    name: 'RecruitAI',
    role: 'RECRUITER',
    category: 'Recruiting',
    persona:
      'You are an AI Recruiter. Source and screen candidates, score resumes ' +
      'against role criteria, schedule interviews, and keep the hiring ' +
      'pipeline moving. Be objective, bias-aware, and cite the evidence ' +
      'behind every recommendation.',
    suggestedSkills: ['email', 'calendar', 'slack'],
    description:
      'Sources and screens candidates, scores resumes, and schedules interviews.',
  },
  {
    key: 'sales-ai',
    name: 'SalesAI',
    role: 'SALES',
    category: 'Sales',
    persona:
      'You are an AI Sales Representative. Qualify inbound leads, answer ' +
      'product questions grounded in the knowledge base, and follow up to ' +
      'move deals forward. Be concise, consultative, and never over-promise.',
    suggestedSkills: ['hubspot', 'email', 'slack'],
    description:
      'Qualifies leads, answers product questions, and follows up to close deals.',
  },
  {
    key: 'support-ai',
    name: 'SupportAI',
    role: 'SUPPORT',
    category: 'Customer Support',
    persona:
      'You are an AI Support Agent. Resolve customer questions grounded in ' +
      'the company knowledge base, cite your sources, and escalate to a ' +
      'human when confidence is low or the request is high-risk.',
    suggestedSkills: ['email', 'slack', 'jira'],
    description:
      'Resolves customer questions from your knowledge base, escalating when needed.',
  },
  {
    key: 'hr-ai',
    name: 'HRAI',
    role: 'HR',
    category: 'Human Resources',
    persona:
      'You are an AI HR Assistant. Answer policy questions, guide employee ' +
      'onboarding, and support the team day to day. Handle sensitive matters ' +
      'with discretion and defer to a human on anything legal or disciplinary.',
    suggestedSkills: ['email', 'calendar', 'gdrive'],
    description:
      'Answers policy questions, helps with onboarding, and supports the team.',
  },
  {
    key: 'finance-ai',
    name: 'FinanceAI',
    role: 'ACCOUNTANT',
    category: 'Finance',
    persona:
      'You are an AI Accountant. Handle bookkeeping questions, review ' +
      'expenses, and prepare finance-related summaries. Always flag anomalies ' +
      'and route any money movement to human approval.',
    suggestedSkills: ['stripe', 'email', 'gdrive'],
    description:
      'Handles bookkeeping questions, expense checks, and finance requests.',
  },
  {
    key: 'pm-ai',
    name: 'PMAI',
    role: 'PROJECT_MANAGER',
    category: 'Project Management',
    persona:
      'You are an AI Project Manager. Coordinate tasks, chase status ' +
      'updates, surface risks early, and keep projects on track. Communicate ' +
      'clearly and keep every stakeholder aligned.',
    suggestedSkills: ['jira', 'slack', 'calendar'],
    description:
      'Coordinates tasks, chases status updates, and keeps projects on track.',
  },

  // --- Step-14 expansions (role: CUSTOM with a tailored persona) -----------
  {
    key: 'marketing-ai',
    name: 'MarketingAI',
    // Was 'CUSTOM' — predates the MARKETING EmployeeRole (added in the P3
    // Marketing wave). Left un-migrated, an employee hired from HERE (instead
    // of onboarding or the create-employee form) had role CUSTOM, which does
    // not satisfy any of the 11 Marketing workflow templates' `requires:
    // {employeeRoles: ['MARKETING']}` prerequisite — installable in the
    // gallery, unusable in every Marketing template. Every other entry in this
    // Step-14 block is genuinely CUSTOM (no dedicated role exists for
    // Procurement/Operations/Legal); this one alone had a real role to use.
    role: 'MARKETING',
    category: 'Marketing',
    persona:
      'You are an AI Marketing Specialist. Draft campaign copy, plan content ' +
      'calendars, summarise market research, and propose channel strategies ' +
      'grounded in the brand voice found in the knowledge base. Keep messaging ' +
      'on-brand and compliant.',
    suggestedSkills: ['email', 'slack', 'gdrive'],
    description:
      'Drafts campaigns, plans content, and proposes go-to-market strategy.',
  },
  {
    key: 'procurement-ai',
    name: 'ProcurementAI',
    role: 'CUSTOM',
    category: 'Procurement',
    persona:
      'You are an AI Procurement Specialist. Compare vendors, draft RFQs, ' +
      'track purchase requests, and summarise contract terms. Optimise for ' +
      'cost, quality, and delivery, and route approvals for any spend.',
    suggestedSkills: ['email', 'gdrive', 'slack'],
    description:
      'Compares vendors, drafts RFQs, and tracks purchase requests.',
  },
  {
    key: 'operations-ai',
    name: 'OperationsAI',
    role: 'CUSTOM',
    category: 'Operations',
    persona:
      'You are an AI Operations Coordinator. Monitor recurring processes, ' +
      'triage incoming requests, produce status reports, and flag ' +
      'bottlenecks. Be systematic, data-driven, and proactive.',
    suggestedSkills: ['slack', 'jira', 'gdrive'],
    description:
      'Monitors processes, triages requests, and reports on operations.',
  },
  {
    key: 'legal-ai',
    name: 'LegalAI',
    role: 'CUSTOM',
    category: 'Legal',
    persona:
      'You are LawyerAI, an AI Legal Assistant. Review and summarise ' +
      'contracts, extract key clauses and obligations, and answer policy ' +
      'questions grounded in the knowledge base. Always add the disclaimer ' +
      'that this is not legal advice and defer material decisions to a ' +
      'qualified human attorney.',
    suggestedSkills: ['gdrive', 'email'],
    description:
      'Reviews contracts, extracts clauses, and answers policy questions.',
  },
] as const;

const WORKFLOW_TEMPLATES: readonly WorkflowTemplateDto[] = [
  {
    key: 'recruiting-resume-score-schedule',
    name: 'Recruiting: resume → score → schedule',
    category: 'Recruiting',
    description:
      'On a new resume, retrieve the role criteria, score the candidate, and ' +
      'branch to scheduling an interview or sending a decline.',
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New resume received', config: {} },
        {
          id: 'criteria',
          type: 'RETRIEVE',
          name: 'Find role criteria',
          config: {
            query: 'hiring criteria and requirements for {{trigger.role}}',
            k: 5,
            outputKey: 'criteria',
          },
        },
        {
          id: 'score',
          type: 'AI_STEP',
          name: 'Score candidate',
          config: {
            prompt:
              'Evaluate the resume against the role criteria.\n' +
              'Resume: {{trigger.resume}}\nCriteria: {{criteria}}\n' +
              'Answer with a single word: "yes" if the candidate qualifies, otherwise "no".',
            outputKey: 'decision',
          },
        },
        {
          id: 'gate',
          type: 'CONDITION',
          name: 'Qualified?',
          config: { left: '{{decision}}', op: 'contains', right: 'yes' },
        },
        {
          id: 'schedule',
          type: 'NOTIFY',
          name: 'Schedule interview',
          config: {
            message:
              'Qualified candidate — scheduling an interview for {{trigger.candidate}}.',
          },
        },
        {
          id: 'decline',
          type: 'NOTIFY',
          name: 'Send decline',
          config: {
            message:
              'Candidate {{trigger.candidate}} did not meet the criteria; sending a polite decline.',
          },
        },
      ],
      edges: [
        { from: 'trigger', to: 'criteria' },
        { from: 'criteria', to: 'score' },
        { from: 'score', to: 'gate' },
        { from: 'gate', to: 'schedule', branch: 'true' },
        { from: 'gate', to: 'decline', branch: 'false' },
      ],
    },
  },
  {
    key: 'sales-outreach',
    name: 'Sales outreach',
    category: 'Sales',
    description:
      'On a new lead, retrieve relevant product context, draft an outreach ' +
      'message, post it to Slack, and log the result.',
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New lead', config: {} },
        {
          id: 'context',
          type: 'RETRIEVE',
          name: 'Gather product context',
          config: {
            query: 'product details relevant to {{trigger.lead}}',
            k: 5,
            outputKey: 'context',
          },
        },
        {
          id: 'draft',
          type: 'AI_STEP',
          name: 'Draft outreach',
          config: {
            prompt:
              'Write a short, friendly outreach message to {{trigger.lead}} ' +
              'using this context: {{context}}. Keep it under 80 words.',
            outputKey: 'message',
          },
        },
        {
          id: 'send',
          type: 'TOOL_ACTION',
          name: 'Post to Slack',
          config: {
            skillKey: 'slack',
            tool: 'send_message',
            args: { channel: '#sales', text: '{{message}}' },
            outputKey: 'sent',
          },
        },
        {
          id: 'done',
          type: 'NOTIFY',
          name: 'Log outreach',
          config: { message: 'Outreach sent to {{trigger.lead}}.' },
        },
      ],
      edges: [
        { from: 'trigger', to: 'context' },
        { from: 'context', to: 'draft' },
        { from: 'draft', to: 'send' },
        { from: 'send', to: 'done' },
      ],
    },
  },
  {
    key: 'support-triage',
    name: 'Support triage',
    category: 'Customer Support',
    description:
      'On a new support question, retrieve knowledge-base context, draft a ' +
      'grounded reply, and log it for review.',
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New support ticket', config: {} },
        {
          id: 'kb',
          type: 'RETRIEVE',
          name: 'Search knowledge base',
          config: { query: '{{trigger.question}}', k: 5, outputKey: 'kb' },
        },
        {
          id: 'answer',
          type: 'AI_STEP',
          name: 'Draft reply',
          config: {
            prompt:
              'Answer the customer question grounded in the knowledge base.\n' +
              'Question: {{trigger.question}}\nContext: {{kb}}\n' +
              'If the context is insufficient, say so and suggest escalation.',
            outputKey: 'answer',
          },
        },
        {
          id: 'log',
          type: 'NOTIFY',
          name: 'Log draft reply',
          config: { message: 'Draft reply ready: {{answer}}' },
        },
      ],
      edges: [
        { from: 'trigger', to: 'kb' },
        { from: 'kb', to: 'answer' },
        { from: 'answer', to: 'log' },
      ],
    },
  },
] as const;

/** Static registry over the built-in marketplace catalog. */
export const MarketplaceCatalog = {
  employees(): EmployeeTemplateDto[] {
    return EMPLOYEE_TEMPLATES.map((t) => ({ ...t }));
  },

  workflows(): WorkflowTemplateDto[] {
    return WORKFLOW_TEMPLATES.map((t) => ({ ...t }));
  },

  getEmployee(key: string): EmployeeTemplateDto | undefined {
    return EMPLOYEE_TEMPLATES.find((t) => t.key === key);
  },

  getWorkflow(key: string): WorkflowTemplateDto | undefined {
    return WORKFLOW_TEMPLATES.find((t) => t.key === key);
  },
};
