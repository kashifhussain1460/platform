import type { SkillDefinitionDto, ToolDefinitionDto } from '@vaep/types';
import {
  executionSupportFor,
  isRealExecutionSupported,
} from './executors/real-execution-support';

/**
 * The built-in SKILLS CATALOG — code, not DB. This is the single source of
 * truth for which skills exist, the tools (actions) each exposes, and their
 * parameter contracts. The database only records which skills a company has
 * INSTALLED, which employees they are ASSIGNED to, and an audit log of
 * executions (see prisma models InstalledSkill / EmployeeSkill / SkillExecution).
 *
 * Executors are mock/sandbox by default (see executors/*). Real API executors
 * and a 3rd-party marketplace are later work.
 */

export type ToolDefinition = ToolDefinitionDto;
export type SkillDefinition = SkillDefinitionDto;

/**
 * The shape actually AUTHORED below. `executionSupport` (per skill) and
 * `simulated` (per tool) are DERIVED from `real-execution-support.ts` when the
 * registry hands an entry out — never hand-written here, so the catalog cannot
 * claim a skill is real while the executor has no `case` for it.
 */
type CatalogEntry = Omit<SkillDefinitionDto, 'executionSupport'>;

const CATALOG: readonly CatalogEntry[] = [
  {
    key: 'slack',
    name: 'Slack',
    description: 'Post messages to Slack channels on behalf of the employee.',
    category: 'communication',
    connection: { type: 'oauth', label: 'Connect Slack' },
    configSchema: [
      {
        key: 'defaultChannel',
        label: 'Default channel',
        type: 'string',
        placeholder: '#general',
        help: 'Channel used when a message does not specify one.',
      },
    ],
    tools: [
      {
        name: 'send_message',
        description: 'Send a message to a Slack channel.',
        parameters: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Target channel, e.g. #general.',
            },
            text: { type: 'string', description: 'The message text to post.' },
          },
          required: ['channel', 'text'],
        },
      },
    ],
  },
  {
    // Your OWN mailbox, over SMTP (plan §7 "Custom SMTP", §10).
    //
    // An address like kashif.hussain@dotsquares.com does not say whether the
    // mailbox is Google Workspace, Microsoft 365, Hostinger or cPanel — and no
    // OAuth app can cover all of them. SMTP is the transport every mail host
    // exposes, so this is the option that works for any company on day one.
    // Google/Microsoft users who want one-click consent instead use the `gmail`
    // skill (and, later, `outlook` — §9); the capability layer treats all of
    // them as EMAIL_SEND, so a workflow does not care which one is connected.
    key: 'email',
    name: 'Company Email (SMTP)',
    description:
      'Send email from your own company mailbox — your domain, Google Workspace, ' +
      'Microsoft 365 or any mail host. Uses SMTP, so no provider app setup is needed.',
    category: 'communication',
    connection: { type: 'api_key', label: 'Connect your mailbox' },
    configSchema: [
      {
        key: 'smtpHost',
        label: 'Mail server (SMTP host)',
        type: 'string',
        required: true,
        placeholder: 'smtp.dotsquares.com',
        help: 'Your provider calls this the outgoing/SMTP server. Google: smtp.gmail.com · Microsoft 365: smtp.office365.com',
      },
      {
        key: 'smtpPort',
        label: 'Port',
        type: 'number',
        required: true,
        placeholder: '587',
        help: '587 for STARTTLS (most common), 465 for SSL/TLS.',
      },
      {
        key: 'smtpSecurity',
        label: 'Security',
        type: 'select',
        options: ['starttls', 'tls', 'none'],
        required: true,
        help: 'Match this to the port: 587 → starttls, 465 → tls. Only use "none" on a trusted internal server.',
      },
      {
        key: 'smtpUser',
        label: 'Username',
        type: 'string',
        required: true,
        placeholder: 'kashif.hussain@dotsquares.com',
        help: 'Usually the full email address of the mailbox.',
      },
      {
        // `secret: true` → stored ENCRYPTED in credentials by configureSkill's
        // partitionConfig, never in the plaintext config column, and returned
        // only as a masked boolean (§4).
        key: 'smtpPassword',
        label: 'Password',
        type: 'string',
        secret: true,
        required: true,
        help: 'If this mailbox uses 2-factor sign-in (Google Workspace, Microsoft 365), create an app password — the normal password will be rejected.',
      },
      {
        key: 'fromAddress',
        label: 'Send as (From address)',
        type: 'string',
        placeholder: 'kashif.hussain@dotsquares.com',
        help: 'Leave blank to use the username. Most servers refuse to send as an address the mailbox does not own.',
      },
      { key: 'fromName', label: 'Sender name', type: 'string', placeholder: 'Dotsquares HR' },
      // ── Inbound (IMAP) — optional ──────────────────────────────────────────
      // Outbound alone is a perfectly valid connection (send-only notification
      // mailboxes are common), so every IMAP field is optional and inbound
      // polling simply does not start until a host is given. Leaving the
      // username/password blank reuses the SMTP ones, which is correct for the
      // overwhelmingly common case of one mailbox doing both.
      {
        key: 'imapHost',
        label: 'Incoming mail server (IMAP host)',
        type: 'string',
        placeholder: 'imap.dotsquares.com',
        help: 'Only needed if Orlixa should READ this mailbox and trigger workflows on new email. Google: imap.gmail.com · Microsoft 365: outlook.office365.com',
      },
      {
        key: 'imapPort',
        label: 'Incoming port',
        type: 'number',
        placeholder: '993',
        help: '993 for SSL/TLS (almost always).',
      },
      {
        key: 'imapSecurity',
        label: 'Incoming security',
        type: 'select',
        options: ['tls', 'starttls', 'none'],
        help: 'Match the port: 993 → tls, 143 → starttls.',
      },
      {
        key: 'imapUser',
        label: 'Incoming username',
        type: 'string',
        help: 'Leave blank to reuse the sending username.',
      },
      {
        key: 'imapPassword',
        label: 'Incoming password',
        type: 'string',
        secret: true,
        help: 'Leave blank to reuse the sending password.',
      },
      {
        key: 'imapFolder',
        label: 'Folder to watch',
        type: 'string',
        placeholder: 'INBOX',
        help: 'Defaults to INBOX.',
      },
      {
        key: 'dailyEmailLimit',
        label: 'Daily email limit',
        type: 'number',
        help: 'Soft cap on emails per day (enforcement is a TODO).',
      },
      { key: 'signature', label: 'Signature', type: 'textarea' },
      { key: 'businessHoursStart', label: 'Business hours start', type: 'string', placeholder: '09:00' },
      { key: 'businessHoursEnd', label: 'Business hours end', type: 'string', placeholder: '17:00' },
    ],
    tools: [
      {
        name: 'send_email',
        description: 'Send an email to a recipient.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body (plain text).' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    ],
  },
  {
    key: 'stripe',
    name: 'Stripe',
    description:
      'Create Stripe payment links, and review recent charges/balance ' +
      '(bookkeeping/expense-check read tools).',
    category: 'payments',
    connection: { type: 'api_key', label: 'Connect Stripe' },
    configSchema: [
      {
        key: 'apiKey',
        label: 'Secret API key',
        type: 'string',
        secret: true,
        placeholder: 'sk_live_...',
        help: 'Stored encrypted-at-rest (TODO); never returned in responses.',
      },
      {
        key: 'currency',
        label: 'Default currency',
        type: 'select',
        options: ['usd', 'eur', 'gbp', 'inr'],
      },
    ],
    tools: [
      {
        name: 'create_payment_link',
        description: 'Create a shareable Stripe payment link.',
        // HIGH-RISK: moving money → always routed to the Approval Center.
        highRisk: true,
        parameters: {
          type: 'object',
          properties: {
            amount: {
              type: 'number',
              description: 'Amount in the smallest currency unit (e.g. cents).',
            },
            currency: {
              type: 'string',
              description: 'ISO currency code, e.g. usd.',
            },
            description: {
              type: 'string',
              description: 'What the payment is for.',
            },
          },
          required: ['amount', 'currency', 'description'],
        },
      },
      {
        // Read-only — no money movement, so NOT highRisk. Backs the
        // "bookkeeping questions / expense checks" FinanceAI is meant to do
        // (previously had zero read tool, only create_payment_link).
        name: 'list_charges',
        description: 'List recent Stripe charges (for expense/bookkeeping review).',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max charges to return (default 10).',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_balance',
        description: "Get the account's current Stripe balance.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
  },
  {
    key: 'github',
    name: 'GitHub',
    description: 'Open issues in GitHub repositories.',
    category: 'development',
    connection: { type: 'api_key', label: 'Connect GitHub' },
    configSchema: [
      { key: 'defaultOrg', label: 'Default organisation', type: 'string' },
      { key: 'defaultRepo', label: 'Default repository', type: 'string', placeholder: 'octo/hello' },
    ],
    tools: [
      {
        name: 'create_issue',
        description: 'Create an issue in a GitHub repository.',
        parameters: {
          type: 'object',
          properties: {
            repo: {
              type: 'string',
              description: 'Repository in owner/name form, e.g. octo/hello.',
            },
            title: { type: 'string', description: 'Issue title.' },
            body: { type: 'string', description: 'Issue body (markdown).' },
          },
          required: ['repo', 'title', 'body'],
        },
      },
      {
        // No real executor case exists for this (intentional — revoking a real
        // person's org access is a destructive, hard-to-reverse action on a
        // live external system). Always falls through to the mock executor.
        name: 'remove_collaborator',
        description: 'Remove a collaborator\'s access to a repository (simulated — no live GitHub call is made).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'Repository in owner/name form, e.g. octo/hello.' },
            username: { type: 'string', description: 'GitHub username to remove.' },
          },
          required: ['repo', 'username'],
        },
      },
    ],
  },
  {
    key: 'http',
    name: 'HTTP',
    description:
      'Make outbound HTTP requests (real, SSRF-guarded — blocks private/internal hosts).',
    category: 'utility',
    connection: { type: 'none' },
    configSchema: [
      { key: 'baseUrl', label: 'Base URL', type: 'string', placeholder: 'https://api.acme.com' },
      { key: 'authHeader', label: 'Authorization header', type: 'string', secret: true },
    ],
    tools: [
      {
        name: 'request',
        description: 'Perform an HTTP request (mock/sandbox response).',
        parameters: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              description: 'HTTP method.',
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            },
            url: { type: 'string', description: 'Absolute request URL.' },
            body: { type: 'string', description: 'Optional request body.' },
          },
          required: ['method', 'url'],
        },
      },
    ],
  },
  {
    key: 'gmail',
    name: 'Gmail',
    description: 'Send and read Gmail on behalf of the employee (OAuth).',
    category: 'communication',
    connection: { type: 'oauth', label: 'Connect Gmail' },
    configSchema: [
      { key: 'companyEmail', label: 'Company email', type: 'string', placeholder: 'team@acme.com' },
      { key: 'dailyEmailLimit', label: 'Daily email limit', type: 'number' },
      { key: 'signature', label: 'Signature', type: 'textarea' },
      { key: 'businessHoursStart', label: 'Business hours start', type: 'string', placeholder: '09:00' },
      { key: 'businessHoursEnd', label: 'Business hours end', type: 'string', placeholder: '17:00' },
      { key: 'canSend', label: 'Can send email', type: 'boolean' },
      { key: 'canRead', label: 'Can read inbox', type: 'boolean' },
    ],
    tools: [
      {
        name: 'send_email',
        description: 'Send an email via Gmail.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body (plain text).' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      {
        name: 'read_inbox',
        description: 'Read recent messages from the inbox.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optional search query.' },
          },
          required: [],
        },
      },
    ],
  },
  {
    key: 'hubspot',
    name: 'HubSpot',
    description: 'Manage contacts and deals in HubSpot CRM (OAuth).',
    category: 'crm',
    connection: { type: 'oauth', label: 'Connect HubSpot' },
    configSchema: [
      { key: 'pipeline', label: 'Default pipeline', type: 'string' },
      { key: 'dealStages', label: 'Deal stages', type: 'string', help: 'Comma-separated list of stage names.' },
      { key: 'leadStatus', label: 'Default lead status', type: 'string' },
    ],
    tools: [
      {
        name: 'create_contact',
        description: 'Create a contact in HubSpot.',
        parameters: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Contact email address.' },
            name: { type: 'string', description: 'Contact full name.' },
          },
          required: ['email'],
        },
      },
      {
        name: 'update_deal',
        description: 'Update a deal in HubSpot.',
        parameters: {
          type: 'object',
          properties: {
            dealId: { type: 'string', description: 'The deal id.' },
            stage: { type: 'string', description: 'New deal stage.' },
          },
          required: ['dealId', 'stage'],
        },
      },
    ],
  },
  {
    key: 'jira',
    name: 'Jira',
    description:
      'Create, read, list, and transition issues in Jira projects (OAuth).',
    category: 'development',
    connection: { type: 'oauth', label: 'Connect Jira' },
    configSchema: [
      { key: 'project', label: 'Default project key', type: 'string', placeholder: 'ENG' },
      { key: 'issueTypes', label: 'Issue types', type: 'string', help: 'Comma-separated list, e.g. Bug,Task.' },
      { key: 'defaultAssignee', label: 'Default assignee', type: 'string' },
    ],
    tools: [
      {
        name: 'create_issue',
        description: 'Create an issue in a Jira project.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project key, e.g. ENG.' },
            summary: { type: 'string', description: 'Issue summary.' },
            description: { type: 'string', description: 'Issue description.' },
          },
          required: ['project', 'summary'],
        },
      },
      {
        // Previously missing entirely — PMAI/OperationsAI's stated jobs
        // ("chase status updates", "triage requests", "monitor processes")
        // need to READ issue state, not just create new ones.
        name: 'list_issues',
        description: 'List issues in a Jira project, optionally filtered by status.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project key, e.g. ENG.' },
            status: { type: 'string', description: 'Filter by status, e.g. "In Progress".' },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_issue',
        description: 'Get one Jira issue by key (status, assignee, description).',
        parameters: {
          type: 'object',
          properties: {
            issueKey: { type: 'string', description: 'Issue key, e.g. ENG-123.' },
          },
          required: ['issueKey'],
        },
      },
      {
        name: 'transition_issue',
        description: 'Move a Jira issue to a new status (e.g. "In Progress" -> "Done").',
        parameters: {
          type: 'object',
          properties: {
            issueKey: { type: 'string', description: 'Issue key, e.g. ENG-123.' },
            status: { type: 'string', description: 'Target status.' },
          },
          required: ['issueKey', 'status'],
        },
      },
    ],
  },
  {
    key: 'calendar',
    name: 'Calendar',
    description: 'Create calendar events on behalf of the employee (OAuth).',
    category: 'productivity',
    connection: { type: 'oauth', label: 'Connect Calendar' },
    configSchema: [
      { key: 'defaultCalendar', label: 'Default calendar', type: 'string' },
      { key: 'timezone', label: 'Timezone', type: 'string', placeholder: 'UTC' },
    ],
    tools: [
      {
        name: 'create_event',
        description: 'Create a calendar event, optionally with a real Google Meet video link.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title.' },
            start: { type: 'string', description: 'ISO start datetime.' },
            end: { type: 'string', description: 'ISO end datetime.' },
            addMeetLink: { type: 'boolean', description: 'Auto-generate a real Google Meet join link for this event.' },
          },
          required: ['title', 'start'],
        },
      },
    ],
  },
  {
    key: 'gdrive',
    name: 'Google Drive',
    description: 'Upload, list, and read files in Google Drive (OAuth).',
    category: 'productivity',
    connection: { type: 'oauth', label: 'Connect Google Drive' },
    configSchema: [
      { key: 'rootFolder', label: 'Root folder', type: 'string' },
    ],
    tools: [
      {
        name: 'upload_file',
        description: 'Upload a file to Google Drive.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name.' },
            content: { type: 'string', description: 'File contents.' },
          },
          required: ['name', 'content'],
        },
      },
      {
        // Previously missing entirely — critical for LegalAI ("extracts
        // clauses" from contracts stored in Drive) and every other role that
        // references docs (HR/Finance/Marketing/Procurement/Operations): with
        // only upload_file, NOTHING could ever read a file's content back.
        name: 'list_files',
        description: 'List files in a Google Drive folder.',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Folder name (default: root folder).' },
          },
          required: [],
        },
      },
      {
        name: 'read_file',
        description: "Read a file's text content from Google Drive by name.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name to read.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_folder',
        description: 'Create a folder in Google Drive (nested under an optional parent folder).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Folder name.' },
            parent: { type: 'string', description: 'Parent folder name (created if missing); default: root folder.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'move_file',
        description: 'Move a file (by name) into a destination folder (by name, created if missing).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name to move.' },
            toFolder: { type: 'string', description: 'Destination folder name.' },
          },
          required: ['name', 'toFolder'],
        },
      },
    ],
  },
  {
    // Internal capability, not a third-party integration — no OAuth/API key
    // (connection: 'none', like http). Backs bulk-hiring interview scheduling:
    // atomically claims the next open slot from the company's InterviewSlot
    // pool (see modules/scheduling) so concurrent candidate workflow runs
    // never double-book the same interview time.
    key: 'scheduling',
    name: 'Interview Scheduling',
    description: 'Claim the next available interview slot from the company\'s bookable pool and create the real Calendar event (+ Meet link) for it.',
    category: 'productivity',
    connection: { type: 'none' },
    configSchema: [],
    tools: [
      {
        name: 'claim_slot',
        description: 'Atomically claim the next open interview slot for a candidate; creates the real Calendar event + Meet link and skips any slot that conflicts with the real calendar.',
        parameters: {
          type: 'object',
          properties: {
            candidateEmail: { type: 'string', description: 'Candidate email the slot is booked for.' },
            title: { type: 'string', description: 'Calendar event title (default: "Interview — <email>").' },
          },
          required: ['candidateEmail'],
        },
      },
      {
        name: 'reschedule_slot',
        description: "Reschedule an already-booked interview: deletes the old Calendar event, cancels the old slot, and claims + schedules a new one for the same candidate.",
        parameters: {
          type: 'object',
          properties: {
            slotId: { type: 'string', description: 'The BOOKED InterviewSlot id to reschedule.' },
            title: { type: 'string', description: 'Calendar event title for the new slot.' },
          },
          required: ['slotId'],
        },
      },
    ],
  },
  {
    key: 'postiz',
    name: 'AI Marketing Manager (Postiz)',
    description:
      'Connect social accounts and schedule/publish posts via the self-hosted Postiz publishing engine.',
    category: 'marketing',
    connection: { type: 'none' }, // company-level OAuth-connect happens per-platform via start_connect_account, not a single skill-level connection
    configSchema: [],
    tools: [
      {
        name: 'list_connected_accounts',
        description: "List the company's connected social accounts.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'start_connect_account',
        description: 'Get an OAuth URL to connect a new social account (e.g. instagram, linkedin).',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', description: 'Postiz platform identifier, e.g. "instagram".' },
          },
          required: ['platform'],
        },
      },
      {
        name: 'schedule_post',
        description: 'Schedule a post to a connected social account for a future date/time.',
        highRisk: true,
        parameters: {
          type: 'object',
          properties: {
            socialAccountId: { type: 'string', description: 'Orlixa SocialAccount id.' },
            content: { type: 'string', description: 'Post text content.' },
            publishAt: { type: 'string', description: 'ISO datetime to publish at.' },
          },
          required: ['socialAccountId', 'content', 'publishAt'],
        },
      },
      {
        name: 'publish_now',
        description: 'Publish a post immediately to a connected social account.',
        highRisk: true,
        parameters: {
          type: 'object',
          properties: {
            socialAccountId: { type: 'string', description: 'Orlixa SocialAccount id.' },
            content: { type: 'string', description: 'Post text content.' },
          },
          required: ['socialAccountId', 'content'],
        },
      },
      {
        name: 'get_post_status',
        description: 'Get the current status of a previously scheduled post.',
        parameters: {
          type: 'object',
          properties: {
            scheduledPostId: { type: 'string', description: 'Orlixa ScheduledPost id.' },
          },
          required: ['scheduledPostId'],
        },
      },
      {
        // M-10: read-only, so NOT highRisk. IMPLEMENTED_UNVERIFIED — see
        // PostizClientService's own doc comment; do not present these numbers
        // to a customer as fact before a real-provider verification pass.
        name: 'get_post_analytics',
        description: "Get a previously scheduled/published post's engagement analytics from Postiz.",
        parameters: {
          type: 'object',
          properties: {
            scheduledPostId: { type: 'string', description: 'Orlixa ScheduledPost id.' },
          },
          required: ['scheduledPostId'],
        },
      },
    ],
  },
  {
    // M-08: an internal, no-OAuth skill (same shape as 'scheduling') backing
    // real consent enforcement for Marketing workflow templates — replaces
    // trusting a workflow-trigger-supplied boolean with a real query against
    // MarketingConsent/MarketingSuppression.
    key: 'marketing',
    name: 'Marketing Compliance',
    description: 'Check real, recorded consent and suppression state before a marketing send.',
    category: 'marketing',
    connection: { type: 'none' },
    configSchema: [],
    tools: [
      {
        name: 'check_consent',
        description: 'Check whether every given address has current, GRANTED consent and is not suppressed for a channel — queries MarketingConsent/MarketingSuppression directly, never trusts a caller-supplied flag.',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', enum: ['EMAIL', 'SMS', 'SOCIAL'], description: 'Suppression/consent channel.' },
            addresses: { type: 'string', description: 'Recipient address(es) — a single address, or comma/semicolon-separated.' },
          },
          required: ['channel', 'addresses'],
        },
      },
    ],
  },
  {
    key: 'chatwoot',
    name: 'AI Customer Support Manager (Chatwoot)',
    description: 'Reply to customer support conversations via the self-hosted Chatwoot Agent Bot.',
    category: 'support',
    connection: { type: 'none' }, // provisioned once per company at onboarding, not per-employee OAuth
    configSchema: [],
    tools: [
      {
        name: 'list_open_conversations',
        description: "List the company's currently open support conversations.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_conversation',
        description: 'Get the full message history of one conversation.',
        parameters: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Orlixa SupportConversation id.' },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'reply_to_conversation',
        description: 'Send a reply into a customer support conversation.',
        // HIGH-RISK (S-04): customer-facing external communication, exactly
        // like postiz.schedule_post/publish_now above — always routed to the
        // Approval Center by default, both from chat and from a workflow
        // TOOL_ACTION node. Do not remove without an explicit, separate
        // approval-routing decision.
        highRisk: true,
        parameters: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Orlixa SupportConversation id.' },
            content: { type: 'string', description: 'Reply text to send to the customer.' },
          },
          required: ['conversationId', 'content'],
        },
      },
      {
        name: 'resolve_conversation',
        description: 'Mark a conversation as resolved.',
        // HIGH-RISK (S-04): same reasoning as reply_to_conversation — a
        // customer-facing support action should never be gated more loosely
        // than an equivalent Marketing action. Currently always returns a
        // NOT_IMPLEMENTED failure (S-02); this flag is kept ready for when a
        // real Chatwoot resolve call is added.
        highRisk: true,
        parameters: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Orlixa SupportConversation id.' },
          },
          required: ['conversationId'],
        },
      },
    ],
  },
  {
    key: 'plane',
    name: 'AI Project Manager (Plane)',
    description: 'Create, track, and update project issues via the self-hosted Plane instance.',
    category: 'project_management',
    connection: { type: 'none' }, // provisioned once per company at onboarding, not per-employee OAuth
    configSchema: [],
    tools: [
      {
        name: 'list_issues',
        description: "List a project's tracked issues.",
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Orlixa PlaneProject id.' },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'create_issue',
        description: 'Create a new issue in a project.',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Orlixa PlaneProject id.' },
            title: { type: 'string', description: 'Issue title.' },
            description: { type: 'string', description: 'Issue description.' },
          },
          required: ['projectId', 'title'],
        },
      },
      {
        name: 'update_issue_status',
        description: 'Update the status/state of an existing issue.',
        parameters: {
          type: 'object',
          properties: {
            issueId: { type: 'string', description: 'Orlixa TrackedIssue id.' },
            status: { type: 'string', description: 'New status (e.g. "In Progress", "Done").' },
          },
          required: ['issueId', 'status'],
        },
      },
    ],
  },
];

/**
 * Decorate an authored entry with the execution-reality fields.
 *
 * Done on the way OUT (rather than baked into the literal) so there is exactly
 * one place that can answer "is this real?", and it is the same place the
 * executor asks.
 */
function decorate(entry: CatalogEntry): SkillDefinition {
  return {
    ...entry,
    executionSupport: executionSupportFor(
      entry.key,
      entry.tools.map((t) => t.name),
    ),
    tools: entry.tools.map((t) => ({
      ...t,
      // Only ever set to `true`; leaving it absent for real tools keeps every
      // existing snapshot/response assertion on real tools unchanged.
      ...(isRealExecutionSupported(entry.key, t.name) ? {} : { simulated: true }),
    })),
  };
}

/** Static registry over the built-in catalog. */
export const SkillCatalog = {
  /** All built-in skills (with their tools). */
  list(): SkillDefinition[] {
    return CATALOG.map(decorate);
  },

  /** Look up a skill by its key. */
  get(key: string): SkillDefinition | undefined {
    const entry = CATALOG.find((s) => s.key === key);
    return entry ? decorate(entry) : undefined;
  },

  /** True when the key names a built-in skill. */
  has(key: string): boolean {
    return CATALOG.some((s) => s.key === key);
  },

  /** Find the tool definition within a skill. */
  getTool(skillKey: string, tool: string): ToolDefinition | undefined {
    return SkillCatalog.get(skillKey)?.tools.find((t) => t.name === tool);
  },

  /**
   * Resolve which skill owns a tool by name, searching the WHOLE catalog.
   * Tool names are NOT globally unique — e.g. both `email` and `gmail` expose
   * `send_email` — so this returns whichever skill happens to appear first in
   * the catalog, which may not be the one actually installed/intended. Kept
   * only as a last-resort fallback; prefer `resolveSkillKey` below whenever a
   * scoped tool list is available.
   */
  skillKeyForTool(tool: string): string | undefined {
    return CATALOG.find((s) => s.tools.some((t) => t.name === tool))?.key;
  },

  /**
   * Resolve which skill owns a returned tool CALL. Prefers the `skillKey` tag
   * on the matching entry of `tools` — the EXACT, already-scoped list this
   * completion call was given (see `SkillsService.getToolsForEmployee`, which
   * tags every tool with its owning installed skill) — since that's
   * unambiguous even when two assigned skills expose a same-named tool.
   * Falls back to the global (ambiguous) search only if the list wasn't
   * tagged, e.g. a caller that doesn't pass `tools` through.
   */
  resolveSkillKey(toolName: string, tools?: ToolDefinition[]): string | undefined {
    const tagged = tools?.find((t) => t.name === toolName)?.skillKey;
    return tagged ?? SkillCatalog.skillKeyForTool(toolName);
  },
};
