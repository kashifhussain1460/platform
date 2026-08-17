import { DarkSectionHeading, DarkHl } from './DarkSectionHeading';
import {
  SlackIcon,
  GmailIcon,
  GoogleDriveIcon,
  HubSpotIcon,
  SalesforceIcon,
  NotionIcon,
  WhatsAppIcon,
  MoreIcon,
} from './brand-icons';

const INTEGRATIONS = [
  { label: 'Slack', Icon: SlackIcon },
  { label: 'Gmail', Icon: GmailIcon },
  { label: 'Google Drive', Icon: GoogleDriveIcon },
  { label: 'HubSpot', Icon: HubSpotIcon },
  { label: 'Salesforce', Icon: SalesforceIcon },
  { label: 'Notion', Icon: NotionIcon },
  { label: 'WhatsApp', Icon: WhatsAppIcon },
  { label: 'More', Icon: MoreIcon, muted: true },
];

/** "Powered by 500+ integrations" — tool logo grid. */
export function IntegrationsSection() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-8">
        <DarkSectionHeading kicker="Powered by 500+ integrations">
          Connect with the <DarkHl>tools</DarkHl> you already use
        </DarkSectionHeading>

        <div className="mt-14 grid grid-cols-4 gap-3 sm:grid-cols-8">
          {INTEGRATIONS.map(({ label, Icon, muted }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-2.5 rounded-xl border border-white/[0.08] bg-void-card px-3 py-5 transition-colors hover:border-white/[0.16]"
            >
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${muted ? 'text-fg-muted' : ''}`}
              >
                <Icon className="h-7 w-7" />
              </span>
              <span className="text-xs font-medium text-zinc-400">{label}</span>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <a href="#" className="text-sm font-medium text-violet-secondary hover:text-white">
            See all integrations →
          </a>
        </div>
      </div>
    </section>
  );
}
