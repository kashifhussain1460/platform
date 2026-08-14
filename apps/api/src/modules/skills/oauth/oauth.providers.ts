import type { ConfigService } from '@nestjs/config';

/**
 * OAuth authorization-code provider registry for `oauth`-type catalog skills.
 * Each provider's client id/secret come from env (`OAUTH_<PROVIDER>_CLIENT_ID` /
 * `OAUTH_<PROVIDER>_CLIENT_SECRET`) and the redirect URI is derived from
 * `OAUTH_REDIRECT_BASE` (the API's public origin). Nothing here is secret at
 * rest — tokens are exchanged at runtime and stored ENCRYPTED on the installed
 * skill. When a provider's env is missing, resolution returns null and the
 * authorize endpoint answers a clear 400.
 */

/** Static per-provider endpoints + auth params (non-secret). */
interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Extra query params appended to the authorize URL (e.g. Google offline). */
  extraAuthParams?: Record<string, string>;
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoints> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // access_type=offline + prompt=consent → Google returns a refresh_token.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
  },
  hubspot: {
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
  },
  atlassian: {
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    extraAuthParams: { audience: 'api.atlassian.com', prompt: 'consent' },
  },
};

/** Maps an `oauth` catalog skill → its provider + requested scopes. */
const SKILL_OAUTH: Record<string, { provider: string; scopes: string[] }> = {
  gmail: {
    provider: 'google',
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  },
  calendar: {
    provider: 'google',
    // calendar.readonly is needed for the FreeBusy conflict-check
    // (SchedulingService) — calendar.events alone gets a 403
    // ACCESS_TOKEN_SCOPE_INSUFFICIENT on that endpoint (found live 2026-07-12).
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  },
  gdrive: {
    provider: 'google',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  },
  hubspot: {
    provider: 'hubspot',
    scopes: ['oauth', 'crm.objects.contacts.write', 'crm.objects.deals.write'],
  },
  jira: {
    provider: 'atlassian',
    scopes: ['read:jira-work', 'write:jira-work', 'offline_access'],
  },
  // channels:read lets the executor resolve a human channel name ("#general")
  // to the id modern chat.postMessage calls require — see real-skill-executor.
  slack: { provider: 'slack', scopes: ['chat:write', 'channels:read'] },
};

/** A fully-resolved provider ready to build an authorize URL / exchange a code. */
export interface ResolvedOAuthProvider {
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  extraAuthParams: Record<string, string>;
  /**
   * WAVE 2 §2.5 — send a PKCE challenge (S256) and the verifier at exchange.
   *
   * ON by default: every provider wired here (Google, Slack, Atlassian, HubSpot)
   * supports PKCE, and a provider that does not simply ignores an unknown
   * `code_challenge`. The escape hatch exists because "ignores it" is not
   * guaranteed — a strict provider can reject an unexpected token-endpoint
   * parameter, and that would break connecting for a whole integration. Turning
   * PKCE off for one provider must not require a deploy:
   *
   *   OAUTH_PKCE_DISABLED_PROVIDERS=hubspot,slack
   */
  pkce: boolean;
}

/** The provider key backing an oauth skill (for clear error messages). */
export function providerForSkill(skillKey: string): string | null {
  return SKILL_OAUTH[skillKey]?.provider ?? null;
}

/**
 * Resolve the OAuth provider for a skill from env. Returns null when the skill is
 * not an oauth skill, or when the provider's client id/secret or the shared
 * redirect base is not configured.
 */
export function resolveOAuthProvider(
  skillKey: string,
  config: ConfigService,
): ResolvedOAuthProvider | null {
  const map = SKILL_OAUTH[skillKey];
  if (!map) {
    return null;
  }
  const endpoints = PROVIDER_ENDPOINTS[map.provider];
  if (!endpoints) {
    return null;
  }
  const upper = map.provider.toUpperCase();
  const clientId = config.get<string>(`OAUTH_${upper}_CLIENT_ID`)?.trim();
  const clientSecret = config.get<string>(`OAUTH_${upper}_CLIENT_SECRET`)?.trim();
  const redirectBase = config.get<string>('OAUTH_REDIRECT_BASE')?.trim();
  if (!clientId || !clientSecret || !redirectBase) {
    return null;
  }
  return {
    provider: map.provider,
    authorizeUrl: endpoints.authorizeUrl,
    tokenUrl: endpoints.tokenUrl,
    scopes: map.scopes,
    clientId,
    clientSecret,
    redirectUri: `${redirectBase.replace(/\/$/, '')}/skills/oauth/callback`,
    extraAuthParams: endpoints.extraAuthParams ?? {},
    pkce: !pkceDisabledFor(map.provider, config),
  };
}

/** Per-provider PKCE kill switch, so a misbehaving provider needs no deploy. */
function pkceDisabledFor(provider: string, config: ConfigService): boolean {
  const raw = config.get<string>('OAUTH_PKCE_DISABLED_PROVIDERS') ?? '';
  return raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .includes(provider.toLowerCase());
}
