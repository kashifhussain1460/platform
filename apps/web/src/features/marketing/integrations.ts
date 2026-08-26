/**
 * Public marketing content for the integrations (Skills) Orlixa actually
 * ships.
 *
 * Source of truth: `apps/api/src/modules/skills/catalog.ts` (`CATALOG`) — the
 * same 14 keys, names, categories and tools. That catalog lives in the API
 * package and isn't reachable from `apps/web`'s build, so this file restates
 * it as marketing copy rather than importing it. If a skill is added, renamed
 * or retired there, mirror the change here.
 *
 * Deliberately NOT included: the homepage's `IntegrationsSection` logo row
 * (Salesforce, Notion, WhatsApp) — those are not implemented skills.
 */

export type ConnectionType = 'oauth' | 'api_key' | 'none';

export interface IntegrationDefinition {
  slug: string;
  name: string;
  category: string;
  description: string;
  connectionType: ConnectionType;
  capabilities: string[];
}

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    slug: 'slack',
    name: 'Slack',
    category: 'Communication',
    description: 'Post messages to Slack channels on behalf of an AI Employee.',
    connectionType: 'oauth',
    capabilities: ['Send a message to a Slack channel'],
  },
  {
    slug: 'email',
    name: 'Company Email (SMTP)',
    category: 'Communication',
    description:
      'Send email from your own company mailbox — your domain, Google Workspace, Microsoft 365 or any mail host — over standard SMTP, with no provider app setup required.',
    connectionType: 'api_key',
    capabilities: ['Send an email to a recipient'],
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    category: 'Communication',
    description: 'Send and read Gmail on behalf of an AI Employee.',
    connectionType: 'oauth',
    capabilities: ['Send an email via Gmail', 'Read recent inbox messages'],
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    description: 'Create payment links and review recent charges and balance.',
    connectionType: 'api_key',
    capabilities: [
      'Create a shareable Stripe payment link (routed through human approval before it executes)',
      'List recent charges for bookkeeping review',
      'Get the account’s current balance',
    ],
  },
  {
    slug: 'github',
    name: 'GitHub',
    category: 'Development',
    description: 'Open issues in GitHub repositories.',
    connectionType: 'api_key',
    capabilities: ['Create an issue in a repository'],
  },
  {
    slug: 'http',
    name: 'HTTP',
    category: 'Utility',
    description: 'Make outbound, SSRF-guarded HTTP requests to your own APIs.',
    connectionType: 'none',
    capabilities: ['Perform an HTTP request to an approved endpoint'],
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    category: 'CRM',
    description: 'Manage contacts and deals in HubSpot CRM.',
    connectionType: 'oauth',
    capabilities: ['Create a contact', 'Update a deal'],
  },
  {
    slug: 'jira',
    name: 'Jira',
    category: 'Development',
    description: 'Create, read, list, and transition issues in Jira projects.',
    connectionType: 'oauth',
    capabilities: [
      'Create an issue',
      'List issues, optionally filtered by status',
      'Get one issue’s details',
      'Move an issue to a new status',
    ],
  },
  {
    slug: 'calendar',
    name: 'Calendar',
    category: 'Productivity',
    description: 'Create calendar events on behalf of an AI Employee.',
    connectionType: 'oauth',
    capabilities: ['Create a calendar event, optionally with a real Google Meet link'],
  },
  {
    slug: 'gdrive',
    name: 'Google Drive',
    category: 'Productivity',
    description: 'Upload, list, read, organize and move files in Google Drive.',
    connectionType: 'oauth',
    capabilities: [
      'Upload a file',
      'List files in a folder',
      'Read a file’s text content',
      'Create a folder',
      'Move a file into a folder',
    ],
  },
  {
    slug: 'scheduling',
    name: 'Interview Scheduling',
    category: 'Productivity',
    description:
      'A built-in scheduling capability (not a third-party app) that atomically claims the next open interview slot and creates the real calendar event and video link for it.',
    connectionType: 'none',
    capabilities: [
      'Claim the next available interview slot for a candidate',
      'Reschedule an already-booked interview',
    ],
  },
  {
    slug: 'postiz',
    name: 'AI Marketing Manager (Postiz)',
    category: 'Marketing',
    description: 'Connect social accounts and schedule or publish posts via the self-hosted Postiz publishing engine.',
    connectionType: 'none',
    capabilities: [
      'List connected social accounts',
      'Connect a new social account',
      'Schedule a post (routed through human approval before it executes)',
      'Publish a post immediately (routed through human approval before it executes)',
      'Check a scheduled post’s status',
    ],
  },
  {
    slug: 'chatwoot',
    name: 'AI Customer Support Manager (Chatwoot)',
    category: 'Support',
    description: 'Reply to customer support conversations via the self-hosted Chatwoot agent bot.',
    connectionType: 'none',
    capabilities: [
      'List open support conversations',
      'Read a conversation’s full history',
      'Reply to a conversation',
      'Mark a conversation resolved',
    ],
  },
  {
    slug: 'plane',
    name: 'AI Project Manager (Plane)',
    category: 'Project Management',
    description: 'Create, track and update project issues via the self-hosted Plane instance.',
    connectionType: 'none',
    capabilities: ['List a project’s issues', 'Create a new issue', 'Update an issue’s status'],
  },
];

export function getIntegrationBySlug(slug: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

export function relatedIntegrations(slug: string, count = 4): IntegrationDefinition[] {
  return INTEGRATIONS.filter((i) => i.slug !== slug).slice(0, count);
}
