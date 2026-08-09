import type { WorkflowTemplateManifest } from '@vaep/types';

/**
 * First-party HR workflow templates (Wave P3-03), reverse-engineered from doc
 * `27-hr-employee-workflows.md`. Frozen-17 node vocabulary only (AI_EMPLOYEE_STEP
 * + TOOL_ACTION, never the banned legacy AI_STEP/NOTIFY); every mandated APPROVAL
 * is a single-forward gate (reject fails the run) and never sits inside a LOOP.
 * `{{param.*}}` placeholders resolve at install; `{{trigger.*}}`/`{{outputKey}}`
 * are runtime refs the engine resolves. All validated by validateManifest on boot
 * + `workflow-templates.catalog.spec.ts`.
 */
export const HR_WORKFLOW_TEMPLATES: readonly WorkflowTemplateManifest[] = [
  {
    key: 'hr.recruitment-intake',
    version: 1,
    name: 'HR: recruitment intake → acknowledge applicant',
    description:
      'On a new application, an HR AI Employee parses it, stores the CV in Drive, and auto-sends an acknowledgement email. A missing CV is flagged for a recruiter, never rejected.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR) that parses the application and sends the acknowledgement.' },
    ],
    requires: { skills: ['gmail', 'gdrive'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Application received', config: {} },
        { id: 'parse', type: 'AI_EMPLOYEE_STEP', name: 'Parse application', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Parse the application in {{trigger.payload}}: pull out the candidate name, email, the role applied for, whether a CV is attached, and a short summary. Do not judge suitability.', outputKey: 'application' } },
        { id: 'hasCv', type: 'CONDITION', name: 'CV attached?', config: { left: '{{application.hasCv}}', op: 'eq', right: 'true' } },
        { id: 'flagNoCv', type: 'SET_VARIABLE', name: 'Flag for recruiter', config: { name: 'status', value: 'NO_CV_ROUTE_TO_RECRUITER', scope: 'OUTPUT' } },
        { id: 'storeCv', type: 'TOOL_ACTION', name: 'Store CV in Drive', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'CV — {{application.candidateName}}', content: '{{trigger.payload.cv}}' } } },
        { id: 'ackEmail', type: 'TOOL_ACTION', name: 'Acknowledge applicant', config: { skillKey: 'gmail', tool: 'send_email', args: { to: '{{application.email}}', subject: 'We received your application', body: 'Hi {{application.candidateName}}, thanks for applying for {{application.role}}. Our team will review your application and be in touch.' } } },
      ],
      edges: [
        { from: 'trigger', to: 'parse' },
        { from: 'parse', to: 'hasCv' },
        { from: 'hasCv', to: 'flagNoCv', branch: 'false' },
        { from: 'hasCv', to: 'storeCv', branch: 'true' },
        { from: 'storeCv', to: 'ackEmail' },
      ],
    },
  },
  {
    key: 'hr.candidate-screening',
    version: 1,
    name: 'HR: candidate screening → recruiter approval → notify',
    description:
      'An HR AI Employee reads the CV from Drive, scores the candidate against the role criteria with justification, a recruiter approves the recommendation, then the result is emailed.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR) that screens the candidate and recommends only.' },
    ],
    requires: { skills: ['gmail', 'gdrive'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Candidate ready to screen', config: {} },
        { id: 'criteria', type: 'RETRIEVE', name: 'Fetch role criteria', config: { query: 'Role criteria, must-have skills and scoring rubric for {{trigger.role}}.', k: 5, outputKey: 'criteria' } },
        { id: 'readCv', type: 'TOOL_ACTION', name: 'Read CV', config: { skillKey: 'gdrive', tool: 'read_file', args: { name: '{{trigger.cvFileName}}' }, outputKey: 'cv' } },
        { id: 'screen', type: 'AI_EMPLOYEE_STEP', name: 'Screen candidate', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Score the CV {{cv}} against the role criteria {{criteria}}. Give a score out of 100 with a written justification and citations, and a recommendation to advance or reject. Never consider age, gender, nationality or photo. Recommend only.', outputKey: 'screening' } },
        { id: 'approval', type: 'APPROVAL', name: 'Recruiter reviews', config: { message: 'Review the screening recommendation before any result reaches the candidate: {{screening}}' } },
        { id: 'notify', type: 'TOOL_ACTION', name: 'Notify result', config: { skillKey: 'gmail', tool: 'send_email', args: { to: '{{trigger.candidateEmail}}', subject: 'Update on your application', body: '{{screening.candidateMessage}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'criteria' },
        { from: 'criteria', to: 'readCv' },
        { from: 'readCv', to: 'screen' },
        { from: 'screen', to: 'approval' },
        { from: 'approval', to: 'notify' },
      ],
    },
  },
  {
    key: 'hr.interview-scheduling',
    version: 1,
    name: 'HR: interview scheduling → book → invite',
    description:
      'An HR AI Employee proposes an interview slot, books it on the calendar with a Meet link, and emails the invite to the candidate. If no slot is available the run is flagged, not silently dropped.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR) that proposes and books the interview slot.' },
    ],
    requires: { skills: ['calendar', 'gmail'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Candidate advanced', config: {} },
        { id: 'propose', type: 'AI_EMPLOYEE_STEP', name: 'Propose slot', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Using the interview process docs and the candidate timezone in {{trigger.payload}}, propose the best interview slot. Return slotFound plus an ISO start and end.', outputKey: 'proposal' } },
        { id: 'gotSlot', type: 'CONDITION', name: 'Slot available?', config: { left: '{{proposal.slotFound}}', op: 'eq', right: 'true' } },
        { id: 'noSlot', type: 'SET_VARIABLE', name: 'Flag no slot', config: { name: 'status', value: 'NO_SLOT_AVAILABLE', scope: 'OUTPUT' } },
        { id: 'book', type: 'TOOL_ACTION', name: 'Book calendar event', config: { skillKey: 'calendar', tool: 'create_event', args: { title: 'Interview — {{trigger.candidateName}}', start: '{{proposal.start}}', end: '{{proposal.end}}', addMeetLink: true }, outputKey: 'event' } },
        { id: 'invite', type: 'TOOL_ACTION', name: 'Email invite', config: { skillKey: 'gmail', tool: 'send_email', args: { to: '{{trigger.candidateEmail}}', subject: 'Your interview is booked', body: 'Hi {{trigger.candidateName}}, your interview is booked for {{proposal.start}}. Join here: {{event.meetLink}}.' } } },
      ],
      edges: [
        { from: 'trigger', to: 'propose' },
        { from: 'propose', to: 'gotSlot' },
        { from: 'gotSlot', to: 'noSlot', branch: 'false' },
        { from: 'gotSlot', to: 'book', branch: 'true' },
        { from: 'book', to: 'invite' },
      ],
    },
  },
  {
    key: 'hr.onboarding',
    version: 1,
    name: 'HR: onboarding checklist → approval → welcome doc + notify',
    description:
      'An HR AI Employee builds an onboarding checklist from policy, a manager approves it, then a welcome doc is created in Drive and the team channel is notified.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR) that generates the onboarding checklist.' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel told that onboarding has started.' },
    ],
    requires: { skills: ['gdrive', 'slack'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Offer accepted', config: {} },
        { id: 'policy', type: 'RETRIEVE', name: 'Fetch onboarding policy', config: { query: 'Onboarding policy and role-specific checklist for {{trigger.role}} in {{trigger.department}}.', k: 5, outputKey: 'policy' } },
        { id: 'buildChecklist', type: 'AI_EMPLOYEE_STEP', name: 'Build checklist', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Generate an onboarding checklist for the new hire in {{trigger.payload}} using the policy {{policy}}. List each task with an owner. Do not provision anything yet.', outputKey: 'checklist' } },
        { id: 'approval', type: 'APPROVAL', name: 'Manager approves', config: { message: 'Approve this onboarding checklist before anything is provisioned: {{checklist}}' } },
        { id: 'welcomeDoc', type: 'TOOL_ACTION', name: 'Create welcome doc', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Onboarding — {{trigger.newHireName}}', content: '{{checklist}}' }, outputKey: 'doc' } },
        { id: 'notify', type: 'TOOL_ACTION', name: 'Notify team', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: 'Onboarding started for {{trigger.newHireName}}. Checklist doc: {{doc.url}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'policy' },
        { from: 'policy', to: 'buildChecklist' },
        { from: 'buildChecklist', to: 'approval' },
        { from: 'approval', to: 'welcomeDoc' },
        { from: 'welcomeDoc', to: 'notify' },
      ],
    },
  },
  {
    key: 'hr.document-verification',
    version: 1,
    name: 'HR: document verification → HR confirms → record',
    description:
      'An HR AI Employee checks an uploaded document for completeness and expiry, an HR officer confirms the outcome, then the file is moved to the verified folder and the result recorded. The machine never asserts a document is genuine.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR) that extracts fields and flags anomalies; never makes the legal determination.' },
    ],
    requires: { skills: ['gdrive'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Document uploaded', config: {} },
        { id: 'readDoc', type: 'TOOL_ACTION', name: 'Read document', config: { skillKey: 'gdrive', tool: 'read_file', args: { name: '{{trigger.fileName}}' }, outputKey: 'docContent' } },
        { id: 'verify', type: 'AI_EMPLOYEE_STEP', name: 'Verify document', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Check the document {{docContent}}: extract the key fields, confirm it is legible and not expired, and flag any anomalies. Never assert the document is genuine, that is a human decision.', outputKey: 'verification' } },
        { id: 'approval', type: 'APPROVAL', name: 'HR confirms', config: { message: 'Confirm this document verification. Right-to-work is a legal decision a machine must not make: {{verification}}' } },
        { id: 'moveToVerified', type: 'TOOL_ACTION', name: 'Move to verified', config: { skillKey: 'gdrive', tool: 'move_file', args: { name: '{{trigger.fileName}}', toFolder: 'Verified Documents' } } },
        { id: 'recordOutcome', type: 'SET_VARIABLE', name: 'Record outcome', config: { name: 'verificationStatus', value: 'VERIFIED', scope: 'OUTPUT' } },
      ],
      edges: [
        { from: 'trigger', to: 'readDoc' },
        { from: 'readDoc', to: 'verify' },
        { from: 'verify', to: 'approval' },
        { from: 'approval', to: 'moveToVerified' },
        { from: 'moveToVerified', to: 'recordOutcome' },
      ],
    },
  },
  {
    key: 'hr.leave-request',
    version: 1,
    name: 'HR: leave request → approval → notify',
    description:
      'On a leave request, an HR AI Employee summarises it, a human approves, then the team channel is notified.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR) handling the request.' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel to notify.' },
    ],
    requires: { skills: ['slack'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Leave request received', config: {} },
        { id: 'summarise', type: 'AI_EMPLOYEE_STEP', name: 'Summarise', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Summarise the leave request in {{trigger.payload}}.', outputKey: 'summary' } },
        { id: 'approval', type: 'APPROVAL', name: 'HR approves', config: { message: 'Approve this leave request?' } },
        { id: 'notify', type: 'TOOL_ACTION', name: 'Notify team', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: '{{summary}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'summarise' },
        { from: 'summarise', to: 'approval' },
        { from: 'approval', to: 'notify' },
      ],
    },
  },
  {
    key: 'hr.attendance-monitor',
    version: 1,
    name: 'HR: attendance anomaly monitor',
    description:
      'On a daily schedule, an HR AI Employee reviews attendance against the working-hours policy, flags anomaly patterns, and posts the summary to a channel. Read-only — it never issues a warning.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role HR) that reviews attendance.' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel the daily summary is posted to.' },
    ],
    requires: { skills: ['slack'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Daily attendance sweep', config: {} },
        { id: 'policy', type: 'RETRIEVE', name: 'Load working-hours policy', config: { query: 'Working-hours policy and shift patterns.', k: 5, outputKey: 'policy' } },
        { id: 'review', type: 'AI_EMPLOYEE_STEP', name: 'Review attendance and flag anomalies', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Aggregate the latest attendance against the working-hours policy in {{policy}} and summarise it. Flag anomaly patterns (late starts, missed shifts, excess overtime). Report only — never issue a warning or disciplinary action.', outputKey: 'anomalies' } },
        { id: 'notify', type: 'TOOL_ACTION', name: 'Post the summary to managers', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: '{{anomalies}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Done', config: {} },
      ],
      edges: [
        { from: 'trigger', to: 'policy' },
        { from: 'policy', to: 'review' },
        { from: 'review', to: 'notify' },
        { from: 'notify', to: 'done' },
      ],
    },
  },
  {
    key: 'hr.performance-review',
    version: 1,
    name: 'HR: performance review draft → approval',
    description:
      'On a review cycle, an HR AI Employee assembles evidence and drafts a structured review; a manager approves it; then the finalised review is saved to Drive and emailed to the employee.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role HR) that drafts the review.' },
    ],
    requires: { skills: ['gdrive', 'gmail'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Review cycle due', config: {} },
        { id: 'draft', type: 'AI_EMPLOYEE_STEP', name: 'Draft the review', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Assemble the available evidence and draft a structured performance review for {{trigger.staffName}} for the manager to edit. Never assign a rating yourself; if evidence is thin, say so explicitly rather than inventing it.', outputKey: 'review' } },
        { id: 'managerApproval', type: 'APPROVAL', name: 'Manager edits and approves the content', config: { message: 'Review and edit the performance draft. The manager owns the content: {{review}}' } },
        { id: 'save', type: 'TOOL_ACTION', name: 'Save the finalised review', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Performance review — {{trigger.staffName}}', content: '{{review}}' } } },
        { id: 'hrReleaseApproval', type: 'APPROVAL', name: 'HR authorises release to the employee', config: { message: 'The manager approved the content; HR owns the release. Approve to send this review to the employee.' } },
        { id: 'email', type: 'TOOL_ACTION', name: 'Email the employee', config: { skillKey: 'gmail', tool: 'send_email', args: { to: '{{trigger.employeeEmail}}', subject: 'Your performance review', body: '{{review}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Done', config: {} },
      ],
      // doc 27 §HR-08: TWO sequential approvals — the manager owns the content,
      // HR owns the release. Save happens after the manager approves; the
      // employee-facing email happens only after the second (HR release) gate.
      edges: [
        { from: 'trigger', to: 'draft' },
        { from: 'draft', to: 'managerApproval' },
        { from: 'managerApproval', to: 'save' },
        { from: 'save', to: 'hrReleaseApproval' },
        { from: 'hrReleaseApproval', to: 'email' },
        { from: 'email', to: 'done' },
      ],
    },
  },
  {
    key: 'hr.record-update',
    version: 1,
    name: 'HR: staff record change → approval',
    description:
      'On a manual or webhook trigger, an HR AI Employee validates and prepares a staff-record change; an HR officer confirms it; then the change is applied and an archived record of it is saved to Drive.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role HR) that prepares the change.' },
    ],
    requires: { skills: ['gdrive'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Record change requested', config: {} },
        { id: 'prepare', type: 'AI_EMPLOYEE_STEP', name: 'Prepare the record change', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Validate the requested staff-record change in {{trigger.payload}}, classify its sensitivity, and prepare the exact before/after values for an HR officer to confirm. Do not apply anything yet.', outputKey: 'change' } },
        { id: 'approval', type: 'APPROVAL', name: 'HR confirms the change', config: { message: 'Confirm the staff-record change before it is applied.' } },
        { id: 'apply', type: 'SET_VARIABLE', name: 'Apply the confirmed change', config: { name: 'appliedChange', value: '{{change}}', scope: 'WORKFLOW' } },
        { id: 'archive', type: 'TOOL_ACTION', name: 'Archive the change record', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Record change — {{trigger.staffId}}', content: '{{change}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Done', config: {} },
      ],
      edges: [
        { from: 'trigger', to: 'prepare' },
        { from: 'prepare', to: 'approval' },
        { from: 'approval', to: 'apply' },
        { from: 'apply', to: 'archive' },
        { from: 'archive', to: 'done' },
      ],
    },
  },
  {
    key: 'hr.compliance-audit',
    version: 1,
    name: 'HR: periodic compliance audit',
    description:
      'On a schedule, an HR AI Employee reviews staff records for compliance gaps, collects the findings, then a single approval authorises the follow-up.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role HR).' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel for the summary.' },
    ],
    requires: { skills: ['gdrive', 'slack'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Scheduled audit', config: {} },
        { id: 'gather', type: 'AI_EMPLOYEE_STEP', name: 'Review records for gaps', config: { employeeId: '{{param.hrEmployee}}', instruction: 'Review staff document records and list compliance gaps.', outputKey: 'findings' } },
        { id: 'approval', type: 'APPROVAL', name: 'HR lead authorises follow-up', config: { message: 'Review the compliance findings and authorise follow-up.' } },
        { id: 'notify', type: 'TOOL_ACTION', name: 'Post the summary', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: '{{findings}}' } } },
      ],
      edges: [
        { from: 'trigger', to: 'gather' },
        { from: 'gather', to: 'approval' },
        { from: 'approval', to: 'notify' },
      ],
    },
  },
  {
    key: 'hr.offboarding',
    version: 1,
    name: 'HR: employee offboarding',
    description:
      'Started manually, an HR AI Employee builds an offboarding checklist; a manager authorises it; then an access-revocation notice is posted to the team channel and the exit document is saved to Drive.',
    category: 'HR',
    parameters: [
      { key: 'hrEmployee', label: 'HR AI Employee', type: 'string', required: true, binds: 'employee', help: 'The AI Employee (role HR) that builds the checklist.' },
      { key: 'notifyChannel', label: 'Notification channel', type: 'string', required: true, binds: 'channel', help: 'Slack channel the access-revocation notice is posted to.' },
    ],
    requires: { skills: ['slack', 'gdrive'], employeeRoles: ['HR'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Offboarding started', config: {} },
        { id: 'checklist', type: 'AI_EMPLOYEE_STEP', name: 'Build the offboarding checklist', config: { employeeId: '{{param.hrEmployee}}', instruction: 'From the offboarding policy, build the checklist for {{trigger.staffName}}: access to revoke, assets to return, and final documents. Sequence the access revocation but do not execute it — a human authorises first.', outputKey: 'checklist' } },
        { id: 'startApproval', type: 'APPROVAL', name: 'HR lead authorises offboarding to start', config: { message: 'Authorise starting the offboarding for {{trigger.staffName}}: {{checklist}}' } },
        { id: 'exitDoc', type: 'TOOL_ACTION', name: 'Save the exit document', config: { skillKey: 'gdrive', tool: 'upload_file', args: { name: 'Exit record — {{trigger.staffName}}', content: '{{checklist}}' } } },
        { id: 'revokeApproval', type: 'APPROVAL', name: 'Authorise access revocation', config: { message: 'Confirm access revocation for {{trigger.staffName}}. This is the pre-revocation authorisation (doc 27 §HR-11): revoking too early strands an active employee, too late leaves a live account.' } },
        { id: 'revokeNotice', type: 'TOOL_ACTION', name: 'Post access-revocation notice', config: { skillKey: 'slack', tool: 'send_message', args: { channel: '{{param.notifyChannel}}', text: 'Access-revocation notice for {{trigger.staffName}}: {{checklist}}' } } },
        { id: 'done', type: 'TERMINATE', name: 'Done', config: {} },
      ],
      // doc 27 §HR-11: TWO approvals — HR lead to START, and a SECOND before
      // access revocation. The revocation notice fires only after the second gate.
      edges: [
        { from: 'trigger', to: 'checklist' },
        { from: 'checklist', to: 'startApproval' },
        { from: 'startApproval', to: 'exitDoc' },
        { from: 'exitDoc', to: 'revokeApproval' },
        { from: 'revokeApproval', to: 'revokeNotice' },
        { from: 'revokeNotice', to: 'done' },
      ],
    },
  },
];
