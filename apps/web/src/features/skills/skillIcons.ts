import { Mail, Globe, Megaphone, Calendar as CalendarLucide, Puzzle } from 'lucide-react';
import {
  GmailIcon,
  SlackIcon,
  HubSpotIcon,
  CalendarIcon,
  GoogleDriveIcon,
  StripeIcon,
  GitHubIcon,
  WhatsAppIcon,
} from '@/components/marketing-dark/brand-icons';
import type { ElementType } from 'react';

/** Real catalog keys only — see apps/api/src/modules/skills/catalog.ts.
 * Falls back to a generic icon for keys with no bespoke brand mark yet
 * (chatwoot, plane, marketing, scheduling, leads, http, email, jira). */
export const SKILL_ICONS: Record<string, ElementType<{ className?: string }>> = {
  gmail: GmailIcon,
  slack: SlackIcon,
  hubspot: HubSpotIcon,
  calendar: CalendarIcon,
  gdrive: GoogleDriveIcon,
  stripe: StripeIcon,
  github: GitHubIcon,
  whatsapp: WhatsAppIcon,
  postiz: Megaphone,
  marketing: Megaphone,
  scheduling: CalendarLucide,
  email: Mail,
  http: Globe,
  jira: Puzzle,
  chatwoot: Puzzle,
  plane: Puzzle,
  leads: Puzzle,
};

export function iconForSkill(key: string): ElementType<{ className?: string }> {
  return SKILL_ICONS[key] ?? Puzzle;
}
