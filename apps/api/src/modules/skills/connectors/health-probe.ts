import { credString } from './credentials.util';
import { asFetchResponse } from '../../../common/http/fetch-response';
import { getProviderAdapter } from '../providers';

/**
 * Per-provider active HEALTH PROBE strategy (docs §1.8): a cheap, authenticated
 * "are you alive?" call. Mirrors the events `ProviderDriver` registry so new
 * providers plug in the SAME way. A probe is PURE of persistence — it only says
 * healthy/unhealthy; ConnectorHealthService owns the status transition.
 *
 * Probes run REAL network calls ONLY in live mode (SKILL_EXECUTOR=real|auto) with
 * real creds; offline/mock the ConnectorHealthService short-circuits to healthy
 * BEFORE reaching a probe (so the test suite never hits the network). When a
 * provider has no dedicated probe, or the connector carries no usable token, the
 * generic probe reports healthy (can't cheaply check → assume ok, labelled mock).
 *
 * TODO [TARGET]: real probes for slack (auth.test), stripe (GET /account),
 * gmail/graph (getProfile), hubspot, jira, etc. — each needs live creds.
 */

export interface HealthProbeResult {
  healthy: boolean;
  /** Failure reason (present when !healthy). */
  error?: string;
  /** True when the probe could not make a real check and assumed healthy. */
  mock?: boolean;
}

export interface HealthProbe {
  probe(
    creds: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<HealthProbeResult>;
}

const PROBE_TIMEOUT_MS = 8_000;

/** fetch() with an abort timeout so a hung provider can't stall the sweep. */
async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return asFetchResponse(await fetch(url, { ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GitHub: `GET /user` with the connector's token (App installation token or PAT).
 * 2xx → healthy; 401/403 → unhealthy (revoked/insufficient). No token → mock
 * healthy (a webhook-only connector has a secret but no API token).
 */
const githubProbe: HealthProbe = {
  async probe(creds) {
    const token = credString(creds, 'accessToken', 'access_token', 'token', 'apiKey');
    if (!token) {
      return { healthy: true, mock: true };
    }
    const res = await fetchWithTimeout('https://api.github.com/user', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'v-aep-connector-health',
      },
    });
    if (!res.ok) {
      return { healthy: false, error: `GitHub probe failed (${res.status})` };
    }
    return { healthy: true };
  },
};

/**
 * Any provider that has a registered ADAPTER (plan §28) gets a real probe for
 * free: `healthCheck()` is the adapter's own cheap authenticated call.
 *
 * This is why the adapter contract is worth having. Previously every provider
 * except GitHub answered "healthy (mock)", so a mailbox whose password had been
 * rotated stayed CONNECTED for ever and only failed at the moment a workflow
 * tried to send — §33 asks for the opposite.
 */
const adapterProbe = (skillKey: string): HealthProbe => ({
  async probe(creds, config) {
    const adapter = getProviderAdapter(skillKey);
    if (!adapter?.healthCheck) {
      return { healthy: true, mock: true };
    }
    const check = await adapter.healthCheck({ creds, config });
    return check.ok
      ? { healthy: true, mock: check.assumed }
      : { healthy: false, error: check.detail ?? 'Health check failed' };
  },
});

/** Fallback: no cheap authenticated check implemented → assume healthy (mock). */
const genericProbe: HealthProbe = {
  async probe() {
    return { healthy: true, mock: true };
  },
};

const PROBES: Record<string, HealthProbe> = {
  github: githubProbe,
  email: adapterProbe('email'),
  gmail: adapterProbe('gmail'),
  calendar: adapterProbe('calendar'),
};

/** Resolve the probe for a provider (generic mock fallback). */
export function getHealthProbe(provider: string): HealthProbe {
  return PROBES[provider] ?? genericProbe;
}
