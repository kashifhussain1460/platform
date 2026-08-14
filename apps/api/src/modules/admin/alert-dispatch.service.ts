import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { MetricsRegistry } from '../../common/observability/metrics.registry';
import { RESILIENCE_REDIS } from '../../common/resilience/redis.provider';
import { ALERT_RULES, type AlertRule } from './alert-rules';

export interface FiringAlert extends AlertRule {
  value: number;
}

export interface AlertSweepResult {
  evaluated: number;
  firing: FiringAlert[];
  /** Whether the firing set was actually sent anywhere. */
  delivered: boolean;
  /** Why not, when it wasn't. Never silently false. */
  reason?: string;
  /**
   * Rules that are firing but were held back by their cooldown window.
   *
   * Reported rather than dropped: "2 firing, 0 notified" must be legible to
   * whoever reads the sweep, or suppression becomes indistinguishable from the
   * silent-failure bug this whole service exists to fix.
   */
  suppressed: string[];
}

/** Default gap between repeat notifications for the SAME rule at the SAME severity. */
const DEFAULT_COOLDOWN_MINUTES = 60;

/**
 * WAVE 9 §Observability — alert DELIVERY.
 *
 * The rules already evaluated correctly at `GET /admin/alerts`, and nothing
 * ever called it: no cron entry, no scraper, no receiver. That is monitoring,
 * not alerting — an alert nobody receives is a log line with ambition. This
 * service is the missing half: evaluate on a schedule, and push what is firing
 * to somewhere a human looks.
 *
 * `ALERT_WEBHOOK_URL` is any JSON-accepting incoming webhook (Slack,
 * Mattermost, PagerDuty Events v2 with a shim, or your own endpoint). Left
 * unset, the sweep still runs and still logs, and reports
 * `delivered:false` with a reason — it does NOT pretend to have paged anyone.
 */
@Injectable()
export class AlertDispatchService {
  private readonly logger = new Logger(AlertDispatchService.name);

  /**
   * Fallback cooldown store, used when Redis is absent: rule key → epoch ms at
   * which it may notify again.
   *
   * In-process, so it does NOT survive a serverless invocation — on a
   * Vercel-style deployment every sweep starts with an empty map and nothing is
   * suppressed. That degrade is deliberate and in the safe direction: an
   * operator who gets a repeat page has been over-notified, one whose page was
   * dropped by a cooldown nobody could see has not been notified at all.
   */
  private readonly memoryCooldown = new Map<string, number>();

  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly config: ConfigService,
    @Optional() @Inject(RESILIENCE_REDIS) private readonly redis?: Redis,
  ) {}

  /** Evaluate every rule against the current gauges. */
  async evaluate(): Promise<FiringAlert[]> {
    // Refresh scrape-time gauges first, or queue/outbox rules would be judged
    // against whatever the last scrape happened to leave behind.
    await this.metrics.render();
    const snapshot = this.metrics.snapshot();

    return ALERT_RULES.flatMap((rule) => {
      // Queue depth is exposed per queue, so match on prefix and sum.
      const names = Object.keys(snapshot).filter(
        (n) => n === rule.metric || n.startsWith(`${rule.metric}_`),
      );
      const value = names.reduce((sum, n) => sum + this.metrics.total(n), 0);
      return value >= rule.threshold ? [{ ...rule, value }] : [];
    });
  }

  /** Evaluate and, if anything is firing, deliver it. */
  async sweep(): Promise<AlertSweepResult> {
    const all = await this.evaluate();
    const base = {
      evaluated: ALERT_RULES.length,
      firing: all,
      suppressed: [] as string[],
    };

    if (all.length === 0) {
      return { ...base, delivered: false, reason: 'nothing firing' };
    }

    this.logger.warn(
      `alerts firing: ${all.map((f) => `${f.name}=${f.value}`).join(', ')}`,
    );

    // Cooldown is per RULE, so a newly-firing rule is never held back by an
    // unrelated one that has been shouting for an hour.
    const notifiable: FiringAlert[] = [];
    const suppressed: string[] = [];
    for (const alert of all) {
      if (await this.inCooldown(alert)) suppressed.push(alert.name);
      else notifiable.push(alert);
    }
    const withSuppressed = { ...base, suppressed };

    if (notifiable.length === 0) {
      // Not a failure — but it must not read as one either way round. The
      // caller is told exactly why nothing was sent.
      return {
        ...withSuppressed,
        delivered: false,
        reason: `all ${suppressed.length} firing alert(s) are within their cooldown window`,
      };
    }
    const firing = notifiable;

    const url = this.config.get<string>('ALERT_WEBHOOK_URL');
    if (!url) {
      // Loud, and reported in the response. An operator reading
      // `delivered:false, reason:...` learns something; a silent 200 teaches
      // them the system is fine.
      this.logger.error(
        'ALERT_WEBHOOK_URL is not set — alerts are firing and NOBODY IS BEING NOTIFIED',
      );
      return {
        ...withSuppressed,
        delivered: false,
        reason: 'ALERT_WEBHOOK_URL not set',
      };
    }

    try {
      const critical = firing.filter((f) => f.severity === 'critical').length;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` is what Slack-compatible receivers render; `alerts` carries the
        // structured detail for anything that parses.
        body: JSON.stringify({
          text:
            `🚨 Orlixa: ${firing.length} alert(s) firing` +
            (critical > 0 ? ` (${critical} critical)` : '') +
            '\n' +
            firing
              .map((f) => `• [${f.severity}] ${f.name} = ${f.value} — ${f.summary}`)
              .join('\n'),
          alerts: firing,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // A 4xx/5xx from the receiver means the page did not land. Saying
        // "delivered" here would be the exact failure this service exists to fix.
        return {
          ...withSuppressed,
          delivered: false,
          reason: `webhook responded ${res.status}`,
        };
      }
      // Start the cooldown ONLY on a page that actually landed. Starting it at
      // send time would mean a webhook outage silenced the rule for the whole
      // window — the failure would suppress the very notification about it.
      await this.startCooldown(firing);
      return { ...withSuppressed, delivered: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`alert delivery failed: ${reason}`);
      return { ...withSuppressed, delivered: false, reason };
    }
  }

  /** Minutes between repeat pages for one rule, `ALERT_COOLDOWN_MINUTES`. */
  private cooldownMs(): number {
    const raw = Number(this.config.get<string>('ALERT_COOLDOWN_MINUTES'));
    const minutes =
      Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_COOLDOWN_MINUTES;
    return minutes * 60_000;
  }

  /**
   * The cooldown key includes the SEVERITY, so a rule escalating from warning
   * to critical pages immediately instead of inheriting the warning's silence.
   * An escalation is new information; suppressing it would hide the moment a
   * problem got worse, which is the moment worth waking someone for.
   */
  private key(alert: FiringAlert): string {
    return `orlixa:alert:cooldown:${alert.name}:${alert.severity}`;
  }

  private async inCooldown(alert: FiringAlert): Promise<boolean> {
    if (this.cooldownMs() === 0) return false;
    const key = this.key(alert);

    if (this.redis) {
      try {
        return (await this.redis.exists(key)) === 1;
      } catch {
        // Redis is unreachable. Fall through to memory rather than treating the
        // error as "in cooldown" — an unreadable store must never be able to
        // silence an alert.
      }
    }
    const until = this.memoryCooldown.get(key);
    return until !== undefined && until > Date.now();
  }

  private async startCooldown(delivered: FiringAlert[]): Promise<void> {
    const ms = this.cooldownMs();
    if (ms === 0) return;

    for (const alert of delivered) {
      const key = this.key(alert);
      this.memoryCooldown.set(key, Date.now() + ms);
      if (!this.redis) continue;
      try {
        // Redis holds the window so it survives a restart and is shared across
        // instances — otherwise every worker pages independently, and a
        // serverless invocation (fresh memory each time) never suppresses at all.
        await this.redis.set(key, '1', 'PX', ms);
      } catch {
        // Best effort. The memory copy still bounds repeats within this process.
      }
    }
  }
}
