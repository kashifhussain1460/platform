import { Injectable } from '@nestjs/common';
import {
  EngineCapabilityUnsupportedError,
  type EngineAdapter,
  type EngineCapability,
  type EngineHealth,
  type EngineWebhookResult,
} from '../engine-adapter';
import { MarketingSyncService } from './marketing-sync.service';
import { PostizClientService } from './postiz-client.service';

/**
 * §39 — Postiz, behind the shared connector contract.
 *
 * The only one of the three with a REAL `reconcile()`: Postiz owns publishing
 * state, so `MarketingSyncService` re-derives local `ScheduledPost` status from
 * it. That is exactly the capability §18 asks for, and the reason the contract
 * has a `reconcile` slot at all — the other two engines are event-driven and
 * mirror nothing, so they say so instead of returning a hollow `{0, 0}`.
 */
@Injectable()
export class PostizEngineAdapter implements EngineAdapter {
  readonly engineKey = 'postiz';

  constructor(
    private readonly postiz: PostizClientService,
    private readonly sync: MarketingSyncService,
  ) {}

  capabilities(): readonly EngineCapability[] {
    return ['connect', 'healthCheck', 'refresh', 'reconcile'];
  }

  tools(): readonly string[] {
    return [
      'postiz.schedule_post',
      'postiz.publish_now',
      'postiz.get_post_status',
      'postiz.list_integrations',
    ];
  }

  /**
   * Returns the URL where a human authorises a social account.
   *
   * Connecting a social network is a browser redirect the user must complete —
   * so `connect()` hands back where to send them rather than pretending it can
   * finish the handshake server-side.
   */
  connect(
    _companyId: string,
    input?: Record<string, unknown>,
  ): Promise<{ url: string }> {
    const platform =
      typeof input?.platform === 'string' ? input.platform.trim() : '';
    if (!platform) {
      // Postiz authorises ONE social network at a time, so there is no
      // meaningful default. Guessing one would send the user to the wrong
      // provider's consent screen.
      return Promise.reject(
        new Error('connect requires a `platform` (e.g. linkedin, x, facebook)'),
      );
    }
    return this.postiz.getConnectUrl(platform);
  }

  disconnect(): Promise<never> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'disconnect',
        'a social account is revoked in Postiz itself; there is no server-side disconnect that would not leave the two sides disagreeing',
      ),
    );
  }

  async healthCheck(): Promise<EngineHealth> {
    // The cheapest read Postiz offers, and it proves the whole path: base URL,
    // API key and the service being up. It mutates nothing.
    try {
      const integrations = await this.postiz.listIntegrations();
      return { ok: true, detail: `${integrations.length} integration(s)` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  refresh(): Promise<void> {
    // Postiz authenticates with a static API key; nothing expires.
    return Promise.resolve();
  }

  /**
   * Re-derive local publish state from Postiz, which is the source of truth.
   *
   * `checked`/`updated` rather than a bare count: "swept 40, changed 0" and
   * "swept 40, changed 40" are very different mornings, and one number cannot
   * tell them apart.
   */
  async reconcile(): Promise<{ checked: number; updated: number }> {
    const result = await this.sync.sweep();
    return { checked: result.reconciled, updated: result.reconciled };
  }

  handleWebhook(): Promise<EngineWebhookResult> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'handleWebhook',
        'Postiz publishes outbound only; publish results are pulled by reconcile() rather than pushed',
      ),
    );
  }
}
