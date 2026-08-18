'use client';

import { useEffect, useRef, useState, type ElementType } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Activity,
  Calendar,
  CalendarClock,
  CreditCard,
  Globe,
  Kanban,
  Mail,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  GitHubIcon,
  GmailIcon,
  GoogleDriveIcon,
  HubSpotIcon,
  SlackIcon,
} from '@/components/marketing-dark/brand-icons';
import { Modal } from '@/components/ui/Modal';
import { RecentConnectorEvents } from '@/features/events/components/RecentConnectorEvents';
import {
  useCatalog,
  useCheckConnectorHealth,
  useInstalledSkills,
  useUninstallSkill,
  useUpdateInstalledSkill,
} from '../hooks';
import { CONNECTION_STATUS_STYLES, formatConnectionStatus } from '../labels';
import type { InstalledSkillDto, SkillDefinitionDto } from '../schemas';
import { SkillSetupWizard } from './SkillSetupWizard';

/** Real brand marks where we have one; a plain lucide glyph in a badge otherwise. */
const CONNECTOR_ICON: Record<string, ElementType<{ className?: string }>> = {
  slack: SlackIcon,
  gmail: GmailIcon,
  gdrive: GoogleDriveIcon,
  hubspot: HubSpotIcon,
  github: GitHubIcon,
  email: Mail,
  stripe: CreditCard,
  http: Globe,
  jira: Kanban,
  calendar: Calendar,
  scheduling: CalendarClock,
};
const BRAND_KEYS = new Set(['slack', 'gmail', 'gdrive', 'hubspot', 'github']);

function ConnectorMark({ skillKey }: { skillKey: string }) {
  const Icon = CONNECTOR_ICON[skillKey] ?? Sparkles;
  if (BRAND_KEYS.has(skillKey)) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center">
        <Icon className="h-9 w-9" />
      </span>
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet">
      <Icon className="h-5 w-5" />
    </span>
  );
}

function ActionIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  danger,
  spin,
}: {
  icon: ElementType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  spin?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-violet/50 bg-violet/15 text-violet'
          : danger
            ? 'border-app-border text-app-ink-2 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600'
            : 'border-app-border text-app-ink-2 hover:border-app-border-strong hover:text-app-ink'
      }`}
    >
      <Icon className={spin ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
    </button>
  );
}

/** One installed-skill card: Settings opens the popup wizard for every skill; events, health, enable/disable, uninstall stay inline. */
function InstalledSkillRow({
  skill,
  def,
}: {
  skill: InstalledSkillDto;
  def?: SkillDefinitionDto;
}) {
  const update = useUpdateInstalledSkill();
  const uninstall = useUninstallSkill();
  const checkHealth = useCheckConnectorHealth();
  const [showEvents, setShowEvents] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const isTemp = skill.id.startsWith('temp_');
  const health = checkHealth.data;

  /**
   * Arrived from AI Assist's "finish connecting it" link (`?connect=<key>`) or
   * the catalog's own anchor. Scroll this row into view and open the popup,
   * because landing at the top of a long Skills page and being told to
   * "connect it" is how people ended up connecting nothing at all.
   */
  const rowRef = useRef<HTMLDivElement>(null);
  const search = useSearchParams();
  const targeted = search.get('connect') === skill.skillKey;
  useEffect(() => {
    if (!targeted) return;
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setShowWizard(true);
  }, [targeted]);

  return (
    <div
      ref={rowRef}
      id={`installed-${skill.skillKey}`}
      className={`scroll-mt-24 rounded-2xl border bg-app-surface p-4 transition-colors ${
        targeted
          ? 'border-violet/60 ring-1 ring-violet/40'
          : 'border-app-border hover:border-app-border-strong'
      }`}
    >
      <div className="flex items-center gap-3">
        <ConnectorMark skillKey={skill.skillKey} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-app-ink">{skill.displayName}</p>
          <span
            className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${CONNECTION_STATUS_STYLES[skill.connectionStatus]}`}
          >
            {formatConnectionStatus(skill.connectionStatus)}
          </span>
        </div>
        {!skill.enabled && (
          <span className="shrink-0 rounded-full bg-app-raised px-2 py-0.5 text-[10px] font-medium text-app-ink-3">
            Disabled
          </span>
        )}
      </div>

      <p className="mt-3 truncate text-xs text-app-ink-3">{skill.skillKey}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!def ? (
          <span className="text-xs text-app-ink-3">Unknown skill</span>
        ) : (
          <button
            type="button"
            onClick={() => setShowWizard(true)}
            disabled={isTemp}
            className="rounded-xl border border-app-border-strong bg-app-surface px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            {skill.connectionStatus === 'CONNECTED'
              ? 'Manage connection'
              : (def.connection?.label ?? 'Set up')}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {def && (
            <ActionIconButton
              icon={Settings}
              label="Settings"
              onClick={() => setShowWizard(true)}
              disabled={isTemp}
            />
          )}
          <ActionIconButton
            icon={Activity}
            label="Events"
            active={showEvents}
            onClick={() => setShowEvents((v) => !v)}
            disabled={isTemp}
          />
          <ActionIconButton
            icon={RefreshCw}
            label="Check health"
            spin={checkHealth.isPending}
            onClick={() => checkHealth.mutate(skill.id)}
            disabled={isTemp || checkHealth.isPending}
          />
          <ActionIconButton
            icon={skill.enabled ? PowerOff : Power}
            label={skill.enabled ? 'Disable' : 'Enable'}
            onClick={() =>
              update.mutate({ id: skill.id, data: { enabled: !skill.enabled } })
            }
            disabled={isTemp || update.isPending}
          />
          <ActionIconButton
            icon={Trash2}
            label="Uninstall"
            danger
            onClick={() => uninstall.mutate(skill.id)}
            disabled={isTemp || uninstall.isPending}
          />
        </div>
      </div>

      {def && (
        <Modal
          open={showWizard}
          onClose={() => setShowWizard(false)}
          title={`Connect ${def.name}`}
          size="lg"
        >
          <SkillSetupWizard installed={skill} def={def} onClose={() => setShowWizard(false)} />
        </Modal>
      )}

      {showEvents && !isTemp && (
        <div className="mt-4 rounded-xl border border-app-border bg-app-surface p-4">
          <p className="mb-2 text-xs font-medium text-app-ink-3">Recent Events</p>
          <RecentConnectorEvents connectorId={skill.id} />
        </div>
      )}

      {(health || checkHealth.isError) && (
        <div className="mt-4 rounded-xl border border-app-border bg-app-surface p-3 text-xs">
          {health ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-app-ink-2">
              <span>
                Health:{' '}
                <span className="font-medium text-app-ink">
                  {formatConnectionStatus(health.status)}
                </span>
              </span>
              <span>Consecutive errors: {health.consecutiveErrors}</span>
              {health.lastHealthError && (
                <span className="text-red-600">
                  Last error: {health.lastHealthError}
                </span>
              )}
              {health.lastHealthCheckAt && (
                <span className="text-app-ink-3">
                  Checked {new Date(health.lastHealthCheckAt).toLocaleString()}
                </span>
              )}
            </div>
          ) : (
            <span className="text-red-600">
              {checkHealth.error?.message ?? 'Health check failed'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Installed skills as connection cards: Settings/connect/events/health/enable/uninstall (all optimistic). */
export function InstalledSkillList() {
  const { data: installed, isLoading } = useInstalledSkills();
  const { data: catalog } = useCatalog();

  const defByKey = new Map((catalog ?? []).map((d) => [d.key, d]));

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading installed skills…</p>;
  }

  if (!installed || installed.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No skills installed yet. Install one from the catalog above.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {installed.map((skill) => (
        <InstalledSkillRow
          key={skill.id}
          skill={skill}
          def={defByKey.get(skill.skillKey)}
        />
      ))}
    </div>
  );
}
