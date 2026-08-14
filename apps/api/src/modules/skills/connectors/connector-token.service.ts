import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InstalledSkill } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import {
  resolveOAuthProvider,
  type ResolvedOAuthProvider,
} from '../oauth/oauth.providers';
import { ConnectorHealthService } from './connector-health.service';
import { TOKEN_REFRESH_SKEW_MS } from './connector.constants';
import { credString, readCredentials, sealCredentials } from './credentials.util';
import type { FetchResponseLike } from '../../../common/http/fetch-response';
import {
  METRIC,
  MetricsRegistry,
} from '../../../common/observability/metrics.registry';

/** Minimal fetch signature (injectable so the refresh flow is unit-testable). */
export type FetchLike = (
  url: string,
  init?: Parameters<typeof fetch>[1],
) => Promise<FetchResponseLike>;

/** DI token for the (swappable/stubbable) fetch used by the token endpoint call. */
export const CONNECTOR_FETCH = Symbol('CONNECTOR_FETCH');

/** Outcome of a refresh-token exchange (discriminated so callers stay total). */
type ExchangeResult =
  | { ok: true; tokens: Record<string, unknown> }
  | { ok: false; revoked: boolean; message: string };

/**
 * ConnectorTokenService — provides a VALID OAuth access token for a connector,
 * refreshing it on/near expiry with a **single-flight** per-connector lock (docs
 * §1.6). Concurrent callers for the same connector await ONE refresh (no
 * thundering herd / token race that would invalidate each other).
 *
 * A refresh whose grant was revoked (`invalid_grant` / 400 / 401) drives the
 * connector DISCONNECTED (+ alert) via ConnectorHealthService; a successful
 * refresh restores CONNECTED and persists the re-encrypted tokens + new expiry.
 *
 * API-key connectors are unaffected — they carry no refresh token, so
 * getAccessToken returns their stored value untouched. Real refresh needs live
 * OAuth creds; offline the flow is exercised with a stubbed `fetch`.
 */
@Injectable()
export class ConnectorTokenService {
  private readonly logger = new Logger(ConnectorTokenService.name);
  /** Per-connector in-flight refresh promises (the single-flight lock). */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly health: ConnectorHealthService,
    @Inject(CONNECTOR_FETCH) private readonly fetchImpl: FetchLike,
    private readonly metrics: MetricsRegistry,
  ) {}

  /**
   * Return a valid access token for the connector. Refreshes (single-flight) when
   * a refresh token exists and the cached `tokenExpiresAt` is near/past; otherwise
   * returns the stored access token as-is (incl. api-key connectors → '').
   */
  async getAccessToken(connectorId: string): Promise<string> {
    const connector = await this.prisma.installedSkill.findUnique({
      where: { id: connectorId },
    });
    if (!connector) {
      return '';
    }
    const creds = readCredentials(this.crypto, connector.credentials);
    const refreshToken = credString(creds, 'refreshToken', 'refresh_token');
    if (!refreshToken || !this.needsRefresh(connector.tokenExpiresAt)) {
      return credString(creds, 'accessToken', 'access_token');
    }
    return this.refreshSingleFlight(connectorId);
  }

  // --- Single-flight refresh ------------------------------------------------

  /** Share one in-flight refresh per connector; late callers await the winner. */
  private refreshSingleFlight(connectorId: string): Promise<string> {
    const existing = this.inflight.get(connectorId);
    if (existing) {
      return existing;
    }
    // Create + register the promise SYNCHRONOUSLY (no await before .set) so
    // concurrent callers always observe the same in-flight refresh.
    const p = this.doRefresh(connectorId).finally(() =>
      this.inflight.delete(connectorId),
    );
    this.inflight.set(connectorId, p);
    return p;
  }

  private async doRefresh(connectorId: string): Promise<string> {
    // Re-read under the lock: a just-completed refresh may already have renewed it.
    const connector = await this.prisma.installedSkill.findUnique({
      where: { id: connectorId },
    });
    if (!connector) {
      return '';
    }
    const creds = readCredentials(this.crypto, connector.credentials);
    const currentAccess = credString(creds, 'accessToken', 'access_token');
    const refreshToken = credString(creds, 'refreshToken', 'refresh_token');
    if (!refreshToken || !this.needsRefresh(connector.tokenExpiresAt)) {
      return currentAccess;
    }

    const provider = resolveOAuthProvider(connector.skillKey, this.config);
    if (!provider) {
      // Our own misconfiguration (no client id/secret) — NOT a revoked grant, so
      // do not DISCONNECT; surface a clear error the caller logs.
      throw new Error(
        `OAuth not configured for ${connector.skillKey}; cannot refresh token`,
      );
    }

    const result = await this.exchangeRefreshToken(provider, refreshToken);
    if (!result.ok) {
      // WAVE 5 §5.3/§5.4 — a refresh-failure spike is the leading indicator of
      // connectors about to disconnect en masse (a rotated client secret, a
      // provider outage). `revoked` is labelled separately because a revoked
      // grant needs a human to reconnect, while a transient failure resolves.
      this.metrics.counter(
        METRIC.oauthRefreshFailureTotal,
        'OAuth token refreshes that failed',
        { skill: connector.skillKey, revoked: String(Boolean(result.revoked)) },
      );
      if (result.revoked) {
        await this.health.markDisconnected(
          connectorId,
          `token refresh: ${result.message}`,
        );
      }
      throw new Error(`token refresh failed: ${result.message}`);
    }

    return this.persistRefreshed(connector, creds, refreshToken, result.tokens);
  }

  /** Merge + re-encrypt the refreshed tokens, restore CONNECTED, return the token. */
  private async persistRefreshed(
    connector: InstalledSkill,
    creds: Record<string, unknown>,
    priorRefreshToken: string,
    tokens: Record<string, unknown>,
  ): Promise<string> {
    const merged = { ...creds, ...tokens };
    // Providers often omit a new refresh token on refresh → keep the prior one.
    if (!credString(merged, 'refreshToken', 'refresh_token')) {
      merged.refreshToken = priorRefreshToken;
    }
    const expiresAtIso = credString(merged, 'expiresAt');
    const tokenExpiresAt = expiresAtIso ? new Date(expiresAtIso) : null;

    await this.prisma.installedSkill.update({
      where: { id: connector.id },
      data: {
        credentials: sealCredentials(this.crypto, merged),
        tokenExpiresAt,
        // A successful refresh proves the connector is healthy again.
        connectionStatus: 'CONNECTED',
        consecutiveErrors: 0,
        lastHealthError: null,
        disabledReason: null,
      },
    });
    this.logger.log(
      `Refreshed access token for connector ${connector.id} (${connector.skillKey})`,
    );
    return credString(merged, 'accessToken', 'access_token');
  }

  // --- Token endpoint (refresh_token grant) --------------------------------

  private async exchangeRefreshToken(
    provider: ResolvedOAuthProvider,
    refreshToken: string,
  ): Promise<ExchangeResult> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
    });
    const res = await this.fetchImpl(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    const data = (await res.json()) as Record<string, unknown>;
    const errorCode = typeof data.error === 'string' ? data.error : '';
    // Slack-style { ok:false } and OAuth { error } both signal failure.
    if (!res.ok || data.ok === false || errorCode) {
      const message = errorCode || `HTTP ${res.status}`;
      // A revoked/expired grant is TERMINAL → the connector needs re-auth.
      const revoked =
        errorCode === 'invalid_grant' ||
        res.status === 400 ||
        res.status === 401;
      return { ok: false, revoked, message };
    }
    const accessToken =
      typeof data.access_token === 'string' ? data.access_token : '';
    if (!accessToken) {
      return { ok: false, revoked: false, message: 'no access_token returned' };
    }
    const expiresIn =
      typeof data.expires_in === 'number' ? data.expires_in : undefined;
    return {
      ok: true,
      tokens: {
        accessToken,
        refreshToken:
          typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        tokenType:
          typeof data.token_type === 'string' ? data.token_type : undefined,
        scope: typeof data.scope === 'string' ? data.scope : undefined,
        expiresAt: expiresIn
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : undefined,
      },
    };
  }

  /** True when a known expiry is within the skew window (or already passed). */
  private needsRefresh(expiresAt: Date | null): boolean {
    if (!expiresAt) {
      return false;
    }
    return expiresAt.getTime() - Date.now() <= TOKEN_REFRESH_SKEW_MS;
  }
}
