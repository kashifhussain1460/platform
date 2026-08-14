import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { asFetchResponse } from '../../../common/http/fetch-response';
import { SkillsService } from '../skills.service';
import {
  providerForSkill,
  resolveOAuthProvider,
  type ResolvedOAuthProvider,
} from './oauth.providers';

/** Decoded, verified OAuth state payload (stateless — HMAC-signed, not stored). */
interface OAuthState {
  installedSkillId: string;
  companyId: string;
  skillKey: string;
  nonce: string;
  /** Issued-at (epoch ms) — the state is rejected after STATE_TTL_MS. */
  iat: number;
  /**
   * Same-origin relative path to bounce the browser back to after the callback
   * (e.g. `/assist/<sessionId>`), so an in-chat connect resumes where it started
   * instead of dumping the user on /skills. Validated again on the way out.
   */
  returnTo?: string;
  /** The user who started the flow — bound into the signed state for traceability. */
  userId?: string;
}

/** Where an in-chat/builder connect flow may return to (open-redirect guard). */
const RETURN_TO_PREFIXES = ['/assist/', '/workflows/'] as const;

/** Signed OAuth state lifetime (defends against stale/replayed authorize links). */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Real OAuth authorization-code flow for `oauth` catalog skills. Stateless: the
 * `state` parameter is an HMAC-signed (CryptoService) envelope carrying the
 * installedSkillId + companyId, so the public callback can trust it with no
 * server-side storage. Tokens obtained from the provider are stored ENCRYPTED on
 * the installed skill (via SkillsService.connectOAuth) and it is marked
 * CONNECTED.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly skills: SkillsService,
    // WAVE 2 §2.5 — one-time state + PKCE need server-side storage.
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Build the provider authorize URL for an installed oauth skill. Throws 400
   * when the skill is not an oauth skill or its provider is not configured.
   */
  async buildAuthorizeUrl(
    companyId: string,
    installedSkillId: string,
    opts: { returnTo?: string; userId?: string } = {},
  ): Promise<string> {
    const installed = await this.skills.getOwnedInstalled(
      companyId,
      installedSkillId,
    );
    const provider = this.resolveOrThrow(installed.skillKey);

    const returnTo = this.safeReturnPath(opts.returnTo);
    const nonce = randomBytes(24).toString('hex');

    // WAVE 2 §2.5 — PKCE (RFC 7636). The verifier stays on the server; only its
    // S256 hash goes to the provider. An authorization code intercepted from the
    // redirect is then useless on its own, which is the entire point: the code
    // travels through the user's browser and the URL bar, the verifier does not.
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // The pending request is what makes the state ONE-TIME. The signed state is
    // kept as well, so a forged nonce is rejected before it ever reaches the DB.
    await this.prisma.oAuthAuthorizationRequest.create({
      data: {
        nonce,
        companyId,
        userId: opts.userId ?? null,
        installedSkillId,
        skillKey: installed.skillKey,
        codeVerifier,
        returnTo: returnTo ?? null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    const state = this.signState({
      installedSkillId,
      companyId,
      skillKey: installed.skillKey,
      nonce,
      iat: Date.now(),
      ...(returnTo ? { returnTo } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
    });

    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      response_type: 'code',
      scope: provider.scopes.join(' '),
      state,
      ...(provider.pkce
        ? { code_challenge: codeChallenge, code_challenge_method: 'S256' }
        : {}),
      ...provider.extraAuthParams,
    });
    return `${provider.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Handle the provider redirect: verify+parse the state, exchange the code for
   * tokens, store them encrypted + mark CONNECTED, and return the web URL to
   * redirect the browser to. Any failure returns a `?error=` web URL rather than
   * throwing so the user lands back on the skills page.
   */
  async handleCallback(
    code: string | undefined,
    stateRaw: string | undefined,
  ): Promise<string> {
    const webBase = this.webOrigin();
    let state: OAuthState;
    try {
      state = this.parseState(stateRaw);
    } catch (err) {
      // No trusted returnTo when the state itself is bad — land on /skills.
      return this.callbackUrl(webBase, '/skills', {
        error: err instanceof Error ? err.message : 'invalid_state',
      });
    }

    // Re-validate on the way out (defence in depth) — the destination is a
    // same-origin relative path or nothing.
    const returnTo = this.safeReturnPath(state.returnTo) ?? '/skills';
    try {
      if (!code) {
        throw new Error('Missing authorization code');
      }
      const provider = this.resolveOrThrow(state.skillKey);
      // WAVE 2 §2.5 — consume the pending request EXACTLY once. The guarded
      // updateMany is the whole mechanism: two concurrent callbacks with the
      // same state race on one row and only the first sees count === 1, so a
      // replayed callback cannot mint a second set of tokens.
      const pending = await this.consumeAuthorizationRequest(state);
      const tokens = await this.exchangeCode(
        provider,
        code,
        pending.codeVerifier,
      );
      await this.skills.connectOAuth(
        state.companyId,
        state.installedSkillId,
        tokens,
      );
      return this.callbackUrl(webBase, returnTo, { connected: state.skillKey });
    } catch (err) {
      // Errors from an in-chat connect use `skillError` so the assist page can
      // surface them without colliding with its own `error` handling.
      const key = returnTo === '/skills' ? 'error' : 'skillError';
      return this.callbackUrl(webBase, returnTo, {
        [key]: err instanceof Error ? err.message : 'oauth_failed',
      });
    }
  }

  /** Compose an absolute redirect from a validated same-origin path + params. */
  private callbackUrl(
    webBase: string,
    path: string,
    params: Record<string, string>,
  ): string {
    const query = new URLSearchParams(params).toString();
    const sep = path.includes('?') ? '&' : '?';
    return `${webBase}${path}${sep}${query}`;
  }

  /**
   * Accept only a SAME-ORIGIN relative path under a known app area — never a
   * protocol-relative (`//host`) or absolute URL — so a crafted `returnTo` can't
   * turn the callback into an open redirect.
   */
  private safeReturnPath(returnTo: string | undefined): string | null {
    if (!returnTo || typeof returnTo !== 'string') return null;
    if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return null;
    if (returnTo.includes('\\') || returnTo.includes('://')) return null;
    return RETURN_TO_PREFIXES.some((p) => returnTo.startsWith(p)) ? returnTo : null;
  }

  // --- Token exchange -------------------------------------------------------

  private async exchangeCode(
    provider: ResolvedOAuthProvider,
    code: string,
    codeVerifier: string,
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      redirect_uri: provider.redirectUri,
      ...(provider.pkce ? { code_verifier: codeVerifier } : {}),
    });
    const res = asFetchResponse(
      await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      }),
    );
    const data = (await res.json()) as Record<string, unknown>;
    // Slack returns HTTP 200 with { ok:false, error } on failure.
    if (!res.ok || data.ok === false) {
      const msg =
        (typeof data.error === 'string' && data.error) ||
        (typeof data.error_description === 'string' && data.error_description) ||
        `token exchange failed (${res.status})`;
      throw new Error(msg);
    }
    const accessToken =
      (typeof data.access_token === 'string' && data.access_token) || '';
    if (!accessToken) {
      throw new Error('Provider did not return an access_token');
    }
    const expiresIn =
      typeof data.expires_in === 'number' ? data.expires_in : undefined;
    return {
      accessToken,
      refreshToken:
        typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      tokenType: typeof data.token_type === 'string' ? data.token_type : undefined,
      scope: typeof data.scope === 'string' ? data.scope : undefined,
      expiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined,
    };
  }

  /**
   * Claim the pending authorization request named by the state, or throw.
   *
   * Every failure mode here is a real attack or a real mistake, and each gets a
   * distinct message so an operator can tell a replay from an expiry:
   *  - unknown nonce      → forged or already-swept state
   *  - already used       → REPLAY
   *  - expired            → the user sat on the consent screen too long
   *  - tenant/skill drift → the signed state and the stored row disagree
   */
  private async consumeAuthorizationRequest(
    state: OAuthState,
  ): Promise<{ codeVerifier: string }> {
    const row = await this.prisma.oAuthAuthorizationRequest.findUnique({
      where: { nonce: state.nonce },
    });
    if (!row) {
      throw new Error('invalid_state');
    }
    if (row.usedAt) {
      throw new Error('state_already_used');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new Error('state_expired');
    }
    // The signed state and the stored row must agree. They are produced
    // together, so any disagreement means one of them was tampered with.
    if (
      row.companyId !== state.companyId ||
      row.installedSkillId !== state.installedSkillId ||
      row.skillKey !== state.skillKey
    ) {
      throw new Error('invalid_state');
    }

    const claimed = await this.prisma.oAuthAuthorizationRequest.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Lost the race with a concurrent callback carrying the same state.
      throw new Error('state_already_used');
    }
    return { codeVerifier: row.codeVerifier };
  }

  // --- Signed state (stateless HMAC) ----------------------------------------

  /** `state = base64url(json).<hmacHex>` — verifiable with no server storage. */
  private signState(payload: OAuthState): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.crypto.sign(body)}`;
  }

  private parseState(stateRaw: string | undefined): OAuthState {
    if (!stateRaw || typeof stateRaw !== 'string' || !stateRaw.includes('.')) {
      throw new Error('invalid_state');
    }
    const idx = stateRaw.lastIndexOf('.');
    const body = stateRaw.slice(0, idx);
    const sig = stateRaw.slice(idx + 1);
    if (!this.crypto.verify(body, sig)) {
      throw new Error('invalid_state');
    }
    let payload: OAuthState;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as OAuthState;
    } catch {
      throw new Error('invalid_state');
    }
    if (
      !payload.installedSkillId ||
      !payload.companyId ||
      !payload.skillKey ||
      typeof payload.iat !== 'number'
    ) {
      throw new Error('invalid_state');
    }
    if (Date.now() - payload.iat > STATE_TTL_MS) {
      throw new Error('state_expired');
    }
    return payload;
  }

  // --- Helpers --------------------------------------------------------------

  private resolveOrThrow(skillKey: string): ResolvedOAuthProvider {
    const provider = resolveOAuthProvider(skillKey, this.config);
    if (!provider) {
      const name = providerForSkill(skillKey) ?? skillKey;
      throw new BadRequestException(`OAuth not configured for ${name}`);
    }
    return provider;
  }

  private webOrigin(): string {
    return (
      this.config.get<string>('WEB_ORIGIN')?.replace(/\/$/, '') ??
      'http://localhost:3000'
    );
  }
}
