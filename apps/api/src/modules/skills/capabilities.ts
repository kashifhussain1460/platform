import type { SkillCapability } from '@vaep/types';
import { SKILL_CAPABILITIES } from '@vaep/types';
import { SkillCatalog } from './catalog';
import { providerForSkill } from './oauth/oauth.providers';

/**
 * Capability-first resolution map (doc 30 §12). The single place that says
 * "which (skill, tool) pairs satisfy a provider-agnostic capability". Workflow
 * planning + the in-chat Skill card resolve requirements THROUGH this map, so a
 * new provider (e.g. Microsoft Outlook for EMAIL_SEND) is added here alone —
 * never in the planner. Every pair below MUST exist in the code catalog; the
 * spec test `capabilities.spec.ts` fails the build if one drifts.
 */
const CAPABILITY_TOOLS: Record<SkillCapability, ReadonlyArray<{ skillKey: string; tool: string }>> = {
  EMAIL_SEND: [
    { skillKey: 'gmail', tool: 'send_email' },
    { skillKey: 'email', tool: 'send_email' },
  ],
  EMAIL_READ: [{ skillKey: 'gmail', tool: 'read_inbox' }],
  CALENDAR_EVENT_CREATE: [
    { skillKey: 'calendar', tool: 'create_event' },
    { skillKey: 'scheduling', tool: 'claim_slot' },
    { skillKey: 'scheduling', tool: 'reschedule_slot' },
  ],
  MESSAGING_SEND: [{ skillKey: 'slack', tool: 'send_message' }],
  CRM_WRITE: [
    { skillKey: 'hubspot', tool: 'create_contact' },
    { skillKey: 'hubspot', tool: 'update_deal' },
  ],
  ISSUE_TRACKING_WRITE: [
    { skillKey: 'jira', tool: 'create_issue' },
    { skillKey: 'jira', tool: 'transition_issue' },
    { skillKey: 'github', tool: 'create_issue' },
    { skillKey: 'plane', tool: 'create_issue' },
    { skillKey: 'plane', tool: 'update_issue_status' },
  ],
  ISSUE_TRACKING_READ: [
    { skillKey: 'jira', tool: 'list_issues' },
    { skillKey: 'jira', tool: 'get_issue' },
    { skillKey: 'plane', tool: 'list_issues' },
  ],
  FILE_STORAGE_WRITE: [
    { skillKey: 'gdrive', tool: 'upload_file' },
    { skillKey: 'gdrive', tool: 'create_folder' },
    { skillKey: 'gdrive', tool: 'move_file' },
  ],
  FILE_STORAGE_READ: [
    { skillKey: 'gdrive', tool: 'list_files' },
    { skillKey: 'gdrive', tool: 'read_file' },
  ],
  PAYMENTS_WRITE: [{ skillKey: 'stripe', tool: 'create_payment_link' }],
  PAYMENTS_READ: [
    { skillKey: 'stripe', tool: 'list_charges' },
    { skillKey: 'stripe', tool: 'get_balance' },
  ],
  SOCIAL_PUBLISH: [
    { skillKey: 'postiz', tool: 'schedule_post' },
    { skillKey: 'postiz', tool: 'publish_now' },
  ],
  SUPPORT_REPLY: [
    { skillKey: 'chatwoot', tool: 'reply_to_conversation' },
    { skillKey: 'chatwoot', tool: 'resolve_conversation' },
  ],
  HTTP_REQUEST: [{ skillKey: 'http', tool: 'request' }],
};

/** `skillKey:tool` → capability, built once from CAPABILITY_TOOLS. */
const TOOL_CAPABILITY = new Map<string, SkillCapability>();
/** capability → the distinct skillKeys that satisfy it (compatible providers). */
const CAPABILITY_SKILLS = new Map<SkillCapability, string[]>();
for (const capability of SKILL_CAPABILITIES) {
  const skillKeys = new Set<string>();
  for (const { skillKey, tool } of CAPABILITY_TOOLS[capability]) {
    TOOL_CAPABILITY.set(`${skillKey}:${tool}`, capability);
    skillKeys.add(skillKey);
  }
  CAPABILITY_SKILLS.set(capability, [...skillKeys]);
}

export const SkillCapabilities = {
  /** Every (skillKey, tool) pair the map references — used by the drift test. */
  allToolRefs(): Array<{ skillKey: string; tool: string; capability: SkillCapability }> {
    return SKILL_CAPABILITIES.flatMap((capability) =>
      CAPABILITY_TOOLS[capability].map((ref) => ({ ...ref, capability })),
    );
  },

  /** The capability a specific tool provides, if any. */
  forTool(skillKey: string, tool: string): SkillCapability | undefined {
    return TOOL_CAPABILITY.get(`${skillKey}:${tool}`);
  },

  /** Installed-catalog skills that could satisfy a capability (multi-provider). */
  skillsFor(capability: SkillCapability): string[] {
    return CAPABILITY_SKILLS.get(capability) ?? [];
  },

  /** Every capability a skill can satisfy (across all its mapped tools). */
  capabilitiesFor(skillKey: string): SkillCapability[] {
    return SKILL_CAPABILITIES.filter((capability) =>
      (CAPABILITY_SKILLS.get(capability) ?? []).includes(skillKey),
    );
  },

  /** Other skills that share any capability with the given skill (alternatives). */
  alternativesFor(skillKey: string): string[] {
    const alts = new Set<string>();
    for (const capability of SKILL_CAPABILITIES) {
      const skills = CAPABILITY_SKILLS.get(capability) ?? [];
      if (skills.includes(skillKey)) {
        for (const other of skills) if (other !== skillKey) alts.add(other);
      }
    }
    return [...alts];
  },

  /** Catalog display name for a skill (e.g. "Gmail"); the raw key if unknown. */
  displayName(skillKey: string): string {
    return SkillCatalog.get(skillKey)?.name ?? skillKey;
  },

  /** OAuth provider group backing a skill (google/slack/…), or null. */
  provider(skillKey: string): string | null {
    return providerForSkill(skillKey);
  },

  /** Catalog connection type (`oauth` | `api_key` | `none`); undefined if unknown skill. */
  connectionType(skillKey: string): 'oauth' | 'api_key' | 'none' | undefined {
    return SkillCatalog.get(skillKey)?.connection.type;
  },

  /** True when the skill needs an authenticated connection before it can run for real. */
  requiresConnection(skillKey: string): boolean {
    const type = SkillCapabilities.connectionType(skillKey);
    return type === 'oauth' || type === 'api_key';
  },
};
