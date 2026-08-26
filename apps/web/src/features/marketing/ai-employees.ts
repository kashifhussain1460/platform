/**
 * Public marketing content for the AI Employee roles Orlixa actually ships.
 *
 * Source of truth: `apps/api/src/modules/marketplace/marketplace.catalog.ts`
 * (`EMPLOYEE_TEMPLATES`) — the same 10 keys, names, roles and personas. That
 * catalog lives in the API package and isn't reachable from `apps/web`'s
 * build, so this file restates it as marketing copy rather than importing it.
 * If a role is added, renamed or retired there, mirror the change here.
 */

export interface AiEmployeeDefinition {
  slug: string;
  name: string;
  /** Human-facing role title used in headings ("AI Recruiter"). */
  title: string;
  role: string;
  category: string;
  tagline: string;
  summary: string;
  responsibilities: string[];
  /** Skill keys from `features/marketing/integrations.ts` this role typically uses. */
  suggestedSkillKeys: string[];
  /** Only set when a real, shipped workflow template demonstrates this role. */
  exampleWorkflow?: { name: string; steps: string[] };
  outcomes: string[];
}

export const AI_EMPLOYEES: AiEmployeeDefinition[] = [
  {
    slug: 'recruit-ai',
    name: 'RecruitAI',
    title: 'AI Recruiter',
    role: 'RECRUITER',
    category: 'Recruiting',
    tagline: 'Sources and screens candidates, scores resumes, and schedules interviews.',
    summary:
      'RecruitAI keeps a hiring pipeline moving: it sources and screens candidates, scores resumes against the criteria you set for a role, and schedules interviews — objectively, and with the evidence behind every recommendation cited.',
    responsibilities: [
      'Score incoming resumes against the criteria for an open role',
      'Shortlist candidates and flag ones that meet the bar',
      'Schedule interviews and keep the pipeline moving',
      'Cite the evidence behind every screening recommendation',
    ],
    suggestedSkillKeys: ['email', 'calendar', 'slack', 'scheduling'],
    exampleWorkflow: {
      name: 'Resume → score → schedule',
      steps: [
        'A new resume comes in',
        'RecruitAI retrieves the role’s hiring criteria from your Knowledge base',
        'It scores the candidate against that criteria',
        'Qualified candidates are routed to interview scheduling; others get a decline',
      ],
    },
    outcomes: [
      'First-pass resume screening happens immediately, not whenever a recruiter has time',
      'Every screening decision is grounded in the same written criteria, applied consistently',
    ],
  },
  {
    slug: 'sales-ai',
    name: 'SalesAI',
    title: 'AI Sales',
    role: 'SALES',
    category: 'Sales',
    tagline: 'Qualifies leads, answers product questions, and follows up to close deals.',
    summary:
      'SalesAI qualifies inbound leads, answers product questions grounded in your knowledge base, and follows up to keep deals moving — concise, consultative, and never over-promising on the product’s behalf.',
    responsibilities: [
      'Qualify inbound leads against your criteria',
      'Answer prospect questions using your knowledge base',
      'Draft and send follow-up outreach',
      'Keep CRM records up to date as a deal progresses',
    ],
    suggestedSkillKeys: ['hubspot', 'email', 'slack'],
    exampleWorkflow: {
      name: 'Sales outreach',
      steps: [
        'A new lead comes in',
        'SalesAI gathers relevant product context from your Knowledge base',
        'It drafts a short, personalized outreach message',
        'The message is posted to your team’s Slack channel and logged',
      ],
    },
    outcomes: [
      'New leads get a response before interest cools off',
      'Reps spend their time on qualified conversations, not first-touch drafting',
    ],
  },
  {
    slug: 'support-ai',
    name: 'SupportAI',
    title: 'AI Support',
    role: 'SUPPORT',
    category: 'Customer Support',
    tagline: 'Resolves customer questions from your knowledge base, escalating when needed.',
    summary:
      'SupportAI resolves customer questions grounded in your knowledge base, cites its sources, and escalates to a human whenever its confidence is low or the request is high-risk — it is built to know what it doesn’t know.',
    responsibilities: [
      'Answer customer questions using your knowledge base',
      'Cite the source behind every answer',
      'Escalate to a human when confidence is low or the request is sensitive',
      'Keep conversation history and context across a support thread',
    ],
    suggestedSkillKeys: ['email', 'slack', 'jira', 'chatwoot'],
    exampleWorkflow: {
      name: 'Support triage',
      steps: [
        'A new support ticket comes in',
        'SupportAI searches your knowledge base for relevant context',
        'It drafts a grounded reply — or says the context is insufficient and suggests escalation',
        'The draft is logged for review',
      ],
    },
    outcomes: [
      'Common questions get answered around the clock',
      'Escalations reach a human with full context already gathered',
    ],
  },
  {
    slug: 'hr-ai',
    name: 'HRAI',
    title: 'AI HR',
    role: 'HR',
    category: 'Human Resources',
    tagline: 'Answers policy questions, helps with onboarding, and supports the team.',
    summary:
      'HRAI answers policy questions, guides new-employee onboarding, and supports the team day to day — handling sensitive matters with discretion and deferring anything legal or disciplinary to a human.',
    responsibilities: [
      'Answer employee questions about company policy',
      'Guide new hires through onboarding steps',
      'Coordinate scheduling for HR-related meetings',
      'Defer legal or disciplinary matters to a human',
    ],
    suggestedSkillKeys: ['email', 'calendar', 'gdrive'],
    outcomes: [
      'Employees get policy answers immediately instead of waiting on HR',
      'Onboarding steps are followed consistently for every new hire',
    ],
  },
  {
    slug: 'finance-ai',
    name: 'FinanceAI',
    title: 'AI Accountant',
    role: 'ACCOUNTANT',
    category: 'Finance',
    tagline: 'Handles bookkeeping questions, expense checks, and finance requests.',
    summary:
      'FinanceAI handles bookkeeping questions, reviews expenses, and prepares finance summaries — flagging anomalies and routing any money movement to human approval before it happens.',
    responsibilities: [
      'Answer bookkeeping and expense questions',
      'Review recent charges and account balances',
      'Prepare finance-related summaries',
      'Flag anomalies and route money movement to human approval',
    ],
    suggestedSkillKeys: ['stripe', 'email', 'gdrive'],
    outcomes: [
      'Routine finance questions get answered without pulling a person off other work',
      'Every payment action still requires a human sign-off before it executes',
    ],
  },
  {
    slug: 'pm-ai',
    name: 'PMAI',
    title: 'AI Project Manager',
    role: 'PROJECT_MANAGER',
    category: 'Project Management',
    tagline: 'Coordinates tasks, chases status updates, and keeps projects on track.',
    summary:
      'PMAI coordinates tasks, chases status updates, surfaces risks early, and keeps a project on track — communicating clearly and keeping every stakeholder aligned.',
    responsibilities: [
      'Track task status across a project',
      'Chase status updates from assigned owners',
      'Surface risks and blockers early',
      'Keep stakeholders aligned with clear updates',
    ],
    suggestedSkillKeys: ['jira', 'slack', 'calendar', 'plane'],
    outcomes: [
      'Status updates get chased consistently instead of falling through the cracks',
      'Risks surface earlier because someone is always watching',
    ],
  },
  {
    slug: 'marketing-ai',
    name: 'MarketingAI',
    title: 'AI Marketing',
    role: 'MARKETING',
    category: 'Marketing',
    tagline: 'Drafts campaigns, plans content, and proposes go-to-market strategy.',
    summary:
      'MarketingAI drafts campaign copy, plans content calendars, summarizes market research, and proposes channel strategy grounded in the brand voice in your knowledge base — kept on-brand and compliant.',
    responsibilities: [
      'Draft campaign and content copy grounded in your brand voice',
      'Plan content calendars',
      'Summarize market research',
      'Propose channel and go-to-market strategy',
    ],
    suggestedSkillKeys: ['email', 'slack', 'gdrive', 'postiz'],
    outcomes: [
      'A first draft exists before a person starts, instead of a blank page',
      'Publishing stays consistent with the brand voice on file',
    ],
  },
  {
    slug: 'procurement-ai',
    name: 'ProcurementAI',
    title: 'AI Procurement',
    role: 'CUSTOM',
    category: 'Procurement',
    tagline: 'Compares vendors, drafts RFQs, and tracks purchase requests.',
    summary:
      'ProcurementAI compares vendors, drafts RFQs, tracks purchase requests, and summarizes contract terms — optimizing for cost, quality and delivery, and routing spend approvals to a human.',
    responsibilities: [
      'Compare vendor options against your criteria',
      'Draft requests for quotation (RFQs)',
      'Track open purchase requests',
      'Summarize contract terms',
    ],
    suggestedSkillKeys: ['email', 'gdrive', 'slack'],
    outcomes: [
      'Vendor comparisons are ready before a buying decision meeting',
      'Every purchase still routes through human approval',
    ],
  },
  {
    slug: 'operations-ai',
    name: 'OperationsAI',
    title: 'AI Operations',
    role: 'CUSTOM',
    category: 'Operations',
    tagline: 'Monitors processes, triages requests, and reports on operations.',
    summary:
      'OperationsAI monitors recurring processes, triages incoming requests, produces status reports, and flags bottlenecks — systematic, data-driven, and proactive.',
    responsibilities: [
      'Monitor recurring operational processes',
      'Triage incoming operational requests',
      'Produce status reports',
      'Flag bottlenecks before they become blockers',
    ],
    suggestedSkillKeys: ['slack', 'jira', 'gdrive'],
    outcomes: [
      'Recurring checks happen on schedule without manual reminders',
      'Bottlenecks get flagged while there is still time to act',
    ],
  },
  {
    slug: 'legal-ai',
    name: 'LegalAI',
    title: 'AI Legal',
    role: 'CUSTOM',
    category: 'Legal',
    tagline: 'Reviews contracts, extracts clauses, and answers policy questions.',
    summary:
      'LegalAI reviews and summarizes contracts, extracts key clauses and obligations, and answers policy questions grounded in your knowledge base — always noting this is not legal advice and deferring material decisions to a qualified human attorney.',
    responsibilities: [
      'Review and summarize contracts',
      'Extract key clauses and obligations',
      'Answer policy questions grounded in your knowledge base',
      'Flag that material decisions require a qualified human attorney',
    ],
    suggestedSkillKeys: ['gdrive', 'email'],
    outcomes: [
      'A first-pass contract summary exists before legal review begins',
      'Obligations and key clauses are easier to find across many documents',
    ],
  },
];

export function getAiEmployeeBySlug(slug: string): AiEmployeeDefinition | undefined {
  return AI_EMPLOYEES.find((e) => e.slug === slug);
}

export function relatedAiEmployees(slug: string, count = 3): AiEmployeeDefinition[] {
  return AI_EMPLOYEES.filter((e) => e.slug !== slug).slice(0, count);
}

/** AI Employees that typically use a given integration (skill key). */
export function employeesUsingSkill(skillSlug: string): AiEmployeeDefinition[] {
  return AI_EMPLOYEES.filter((e) => e.suggestedSkillKeys.includes(skillSlug));
}
