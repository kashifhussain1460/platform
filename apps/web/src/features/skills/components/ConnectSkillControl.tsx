'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { NormalizedApiError } from '@/lib/apiClient';
import { authorizeOAuth } from '../api';
import { useConnectSkill, useDisconnectSkill } from '../hooks';
import type { InstalledSkillDto, SkillDefinitionDto } from '../schemas';

const outlinePill =
  'rounded-xl border border-app-border-strong bg-app-surface px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Connect / disconnect control for an installed skill.
 * - `api_key` skills prompt inline for a secret key (stored in credentials).
 * - `oauth` skills start the REAL authorization-code flow: fetch the provider
 *   URL from the API and redirect the browser there (the API callback stores the
 *   tokens and returns to /skills?connected=…). If OAuth is not configured the
 *   API returns 400 and we surface the message inline.
 * - `none` skills need no connection.
 */
export function ConnectSkillControl({
  installed,
  def,
  returnTo,
}: {
  installed: InstalledSkillDto;
  def: SkillDefinitionDto;
  /**
   * Where the OAuth callback should send the browser back to, e.g.
   * `/employees/<id>` from the per-employee "connect just for me" picker.
   * Defaults to `/skills` (the API's own default) when omitted — the generic
   * catalog page, which is where this control is normally mounted.
   */
  returnTo?: string;
}) {
  const connect = useConnectSkill();
  const disconnect = useDisconnectSkill();
  const [apiKey, setApiKey] = useState('');
  const [open, setOpen] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const startOAuth = async () => {
    setOauthError(null);
    setAuthorizing(true);
    try {
      const { url } = await authorizeOAuth(installed.id, returnTo);
      // Full-page redirect to the provider's consent screen.
      window.location.href = url;
    } catch (err) {
      setOauthError((err as NormalizedApiError).message ?? 'OAuth failed');
      setAuthorizing(false);
    }
  };

  const type = def.connection?.type ?? 'none';
  const isConnected = installed.connectionStatus === 'CONNECTED';
  const isTemp = installed.id.startsWith('temp_');

  if (type === 'none') {
    return <span className="text-xs text-app-ink-3">No connection required</span>;
  }

  /**
   * A skill with no real executor must not ask for real credentials.
   *
   * `SIMULATED` means not one of this skill's tools reaches a live provider —
   * today that is `stripe`, `github`, `hubspot` and `jira`. Two of them have
   * fully working OAuth, so before this a customer could hand Orlixa live
   * read/write access to their CRM and see CONNECTED, for a capability that does
   * not exist. The `api_key` branch below was the same problem without the
   * consent screen.
   *
   * The server refuses this too (`OAuthService.assertCanActuallyAct`) — this is
   * the half that stops a customer walking into it, not the half that enforces
   * it. Hiding a control is never the control.
   *
   * The skill stays installed and usable: a simulated run is a legitimate way to
   * try a workflow out. Only the credential handover is blocked.
   */
  if (def.executionSupport === 'SIMULATED') {
    return (
      <span className="text-xs text-sl-warning">
        Demo only — nothing to connect yet
      </span>
    );
  }

  if (isConnected) {
    return (
      <button
        type="button"
        onClick={() => disconnect.mutate(installed.id)}
        disabled={isTemp || disconnect.isPending}
        className={outlinePill}
      >
        {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
      </button>
    );
  }

  if (type === 'oauth') {
    return (
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={startOAuth}
          disabled={isTemp || authorizing}
          className={outlinePill}
        >
          {authorizing ? 'Redirecting…' : (def.connection?.label ?? 'Connect')}
        </button>
        {oauthError ? (
          <span className="text-[10px] text-red-600">{oauthError}</span>
        ) : (
          <span className="text-[10px] text-app-ink-3">OAuth</span>
        )}
      </div>
    );
  }

  // api_key
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={isTemp}
        className={outlinePill}
      >
        {def.connection?.label ?? 'Connect'}
      </button>
    );
  }

  // Slack's real executor reads `botToken` (or `webhookUrl`), not a generic
  // `apiKey` — every other api_key skill here (stripe/github/email) is
  // mock-only so the field name doesn't matter for them yet.
  const isSlack = def.key === 'slack';

  return (
    <div className="flex items-center gap-2">
      <div className="w-40">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isSlack ? 'Bot token (xoxb-...)' : 'API key'}
          className="field-modern"
        />
      </div>
      <Button
        variant="violet"
        onClick={() =>
          connect.mutate(
            {
              id: installed.id,
              data: { credentials: isSlack ? { botToken: apiKey } : { apiKey } },
            },
            {
              onSuccess: () => {
                setApiKey('');
                setOpen(false);
              },
            },
          )
        }
        disabled={!apiKey || connect.isPending}
      >
        {connect.isPending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
