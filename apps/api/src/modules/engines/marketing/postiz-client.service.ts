import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
import { ResilientClientBase } from '../../../common/resilience/resilient-client.base';
import {
  POSTIZ_ENV,
  POSTIZ_RATE_LIMIT,
  POSTIZ_RATE_WINDOW_MS,
  POSTIZ_RESOURCE_KEY,
} from './marketing.constants';

export interface SchedulePostInput {
  postizIntegrationId: string;
  content: string;
  type: 'draft' | 'schedule' | 'now';
  date?: string; // ISO datetime, required when type === 'schedule'
  mediaUrls?: string[];
}

export interface PostizIntegrationDto {
  id: string;
  name: string;
  identifier: string;
  picture?: string;
  disabled: boolean;
  customer?: { id: string; name: string };
}

export interface PostizPostDto {
  id: string;
  state: string;
  releaseId?: string;
  releaseURL?: string;
}

/**
 * M-10: Postiz's real, documented analytics response shape
 * (docs/architecture/engines/postiz-engine.md — `GET /public/v1/analytics/
 * :integration` and `/analytics/post/:postId`). Loosely typed on purpose —
 * this has NOT been verified against a live Postiz instance (no self-hosted
 * instance exists in this dev environment), so treat every field as
 * IMPLEMENTED_UNVERIFIED until a real-provider pass confirms it. Never
 * present these numbers to a customer as fact before that pass runs.
 */
export interface PostizIntegrationAnalyticsDto {
  integration?: string;
  [metric: string]: unknown;
}

export interface PostizPostAnalyticsDto {
  post?: string;
  [metric: string]: unknown;
}

/**
 * Thin, typed wrapper around the self-hosted Postiz public API
 * (docs/architecture/engines/postiz-engine.md §11, postiz-integration-plan.md).
 * One shared API key for the whole Orlixa deployment — never per-company.
 *
 * Extends ResilientClientBase (C-07): every call below goes through
 * `guardedFetch` with the SAME global `POSTIZ_RESOURCE_KEY` — one circuit
 * breaker and one rate-limit budget shared across every tenant, matching how
 * Postiz itself is actually deployed (see marketing.constants.ts). This
 * protects BOTH the tool-call path (via RealSkillExecutor) and
 * MarketingSyncService.sweep()'s direct calls, which never went through
 * SkillsService's own connector-keyed wrap at all.
 */
@Injectable()
export class PostizClientService extends ResilientClientBase {
  private readonly logger = new Logger(PostizClientService.name);

  constructor(
    private readonly config: ConfigService,
    breakers: CircuitBreakerRegistry,
    rateLimiter: RateLimiter,
  ) {
    super(breakers, rateLimiter);
  }

  private baseUrl(): string {
    const url = this.config.get<string>(POSTIZ_ENV.BASE_URL);
    if (!url) throw new Error(`${POSTIZ_ENV.BASE_URL} is not configured`);
    return url.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    const key = this.config.get<string>(POSTIZ_ENV.API_KEY);
    if (!key) throw new Error(`${POSTIZ_ENV.API_KEY} is not configured`);
    return { Authorization: key, 'content-type': 'application/json' };
  }

  private async postizFetch(input: string, init?: RequestInit) {
    return this.guardedFetch(POSTIZ_RESOURCE_KEY, input, init, {
      limit: POSTIZ_RATE_LIMIT,
      windowMs: POSTIZ_RATE_WINDOW_MS,
    });
  }

  async getConnectUrl(platform: string, refreshIntegrationId?: string): Promise<{ url: string }> {
    const qs = refreshIntegrationId ? `?refresh=${encodeURIComponent(refreshIntegrationId)}` : '';
    const res = await this.postizFetch(`${this.baseUrl()}/public/v1/social/${platform}${qs}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz getConnectUrl(${platform}) failed (${res.status}): ${text}`);
      throw new Error(`Postiz getConnectUrl(${platform}) failed: ${res.status}`);
    }
    return (await res.json()) as { url: string };
  }

  async listIntegrations(group?: string): Promise<PostizIntegrationDto[]> {
    const qs = group ? `?group=${encodeURIComponent(group)}` : '';
    const res = await this.postizFetch(`${this.baseUrl()}/public/v1/integrations${qs}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz listIntegrations failed (${res.status}): ${text}`);
      throw new Error(`Postiz listIntegrations failed: ${res.status}`);
    }
    return (await res.json()) as PostizIntegrationDto[];
  }

  async schedulePost(input: SchedulePostInput): Promise<{ postizPostId: string }> {
    const body = {
      type: input.type,
      date: input.date,
      posts: [
        {
          integration: { id: input.postizIntegrationId },
          value: [{ content: input.content }],
        },
      ],
    };
    const res = await this.postizFetch(`${this.baseUrl()}/public/v1/posts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz schedulePost failed (${res.status}): ${text}`);
      throw new Error(`Postiz schedulePost failed: ${res.status}`);
    }
    const data = (await res.json()) as { id?: string; postId?: string };
    const postizPostId = data.id ?? data.postId;
    if (!postizPostId) {
      throw new Error('Postiz schedulePost returned no post id');
    }
    return { postizPostId };
  }

  async listPosts(): Promise<PostizPostDto[]> {
    const res = await this.postizFetch(`${this.baseUrl()}/public/v1/posts`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz listPosts failed (${res.status}): ${text}`);
      throw new Error(`Postiz listPosts failed: ${res.status}`);
    }
    return (await res.json()) as PostizPostDto[];
  }

  /**
   * M-10: per-integration (per social account) analytics — engagement/reach
   * over Postiz's own connected-account metrics. IMPLEMENTED_UNVERIFIED
   * (see the DTO's own doc comment) until checked against a live instance.
   */
  async getIntegrationAnalytics(
    postizIntegrationId: string,
  ): Promise<PostizIntegrationAnalyticsDto> {
    const res = await this.postizFetch(
      `${this.baseUrl()}/public/v1/analytics/${postizIntegrationId}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz getIntegrationAnalytics failed (${res.status}): ${text}`);
      throw new Error(`Postiz getIntegrationAnalytics failed: ${res.status}`);
    }
    return (await res.json()) as PostizIntegrationAnalyticsDto;
  }

  /**
   * M-10: per-post analytics. IMPLEMENTED_UNVERIFIED (see the DTO's own doc
   * comment) until checked against a live instance.
   */
  async getPostAnalytics(postizPostId: string): Promise<PostizPostAnalyticsDto> {
    const res = await this.postizFetch(
      `${this.baseUrl()}/public/v1/analytics/post/${postizPostId}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz getPostAnalytics failed (${res.status}): ${text}`);
      throw new Error(`Postiz getPostAnalytics failed: ${res.status}`);
    }
    return (await res.json()) as PostizPostAnalyticsDto;
  }
}
