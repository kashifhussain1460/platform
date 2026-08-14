import type { ConfigService } from '@nestjs/config';
import type { MetricsRegistry } from '../../common/observability/metrics.registry';
import { AlertDispatchService } from './alert-dispatch.service';
import { ALERT_RULES } from './alert-rules';

/**
 * WAVE 9 §Observability — alert delivery.
 *
 * The bug this covers is not "the threshold arithmetic is wrong". It is that
 * the rules evaluated perfectly and NOTHING EVER CALLED THEM, so a firing alert
 * reached exactly nobody. These tests are about whether a human finds out.
 */
describe('AlertDispatchService', () => {
  const queueRule = ALERT_RULES.find((r) => r.name === 'queue_backlog')!;

  /** A registry where the queue-depth metric sits at `value`. */
  const registryWith = (value: number) =>
    ({
      render: jest.fn().mockResolvedValue(''),
      snapshot: jest.fn().mockReturnValue({ [queueRule.metric]: value }),
      total: jest.fn().mockReturnValue(value),
    }) as unknown as MetricsRegistry;

  /**
   * Key-aware on purpose: a mock that returns the webhook URL for EVERY key
   * would also answer `ALERT_COOLDOWN_MINUTES` with a URL, and the cooldown
   * tests below would be silently exercising the default instead of the value
   * they set.
   */
  const configWith = (url?: string, cooldownMinutes?: string) =>
    ({
      get: jest.fn((key: string) =>
        key === 'ALERT_COOLDOWN_MINUTES' ? cooldownMinutes : url,
      ),
    }) as unknown as ConfigService;

  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('says nothing is firing when everything is below threshold', async () => {
    const svc = new AlertDispatchService(registryWith(0), configWith('https://hook'));
    const result = await svc.sweep();

    expect(result.firing).toHaveLength(0);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('nothing firing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DELIVERS a firing alert to the webhook', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const svc = new AlertDispatchService(
      registryWith(queueRule.threshold + 1),
      configWith('https://hook.example.com/x'),
    );

    const result = await svc.sweep();

    expect(result.firing.map((f) => f.name)).toContain('queue_backlog');
    expect(result.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.example.com/x');
    const body = JSON.parse((init as { body: string }).body);
    // The human-readable line must name the rule and its value — a payload that
    // only says "an alert fired" sends someone hunting.
    expect(body.text).toMatch(/queue_backlog/);
    expect(body.alerts[0].value).toBe(queueRule.threshold + 1);
  });

  it('reports delivered:false with a REASON when no webhook is configured', async () => {
    // The dangerous outcome is a green tick: a cron that returns 200 while
    // nobody is notified teaches an operator the system is healthy.
    const svc = new AlertDispatchService(
      registryWith(queueRule.threshold + 1),
      configWith(undefined),
    );

    const result = await svc.sweep();

    expect(result.firing.length).toBeGreaterThan(0);
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/ALERT_WEBHOOK_URL/);
  });

  it('does not claim delivery when the receiver rejects it', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const svc = new AlertDispatchService(
      registryWith(queueRule.threshold + 1),
      configWith('https://hook'),
    );

    const result = await svc.sweep();

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/500/);
  });

  it('does not claim delivery when the webhook throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new AlertDispatchService(
      registryWith(queueRule.threshold + 1),
      configWith('https://hook'),
    );

    const result = await svc.sweep();

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  // ── cooldown ──────────────────────────────────────────────────────────────
  // A rule above threshold stays above threshold. Without a cooldown the 15-min
  // cron re-pages for ever, and the volume is what trains an operator to ignore
  // the channel — which costs more than the original missing alert did.

  describe('cooldown', () => {
    const firingSvc = (cooldownMinutes?: string) =>
      new AlertDispatchService(
        registryWith(queueRule.threshold + 1),
        configWith('https://hook', cooldownMinutes),
      );

    it('does not re-notify the same rule within the window', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const svc = firingSvc('60');

      const first = await svc.sweep();
      const second = await svc.sweep();

      expect(first.delivered).toBe(true);
      expect(second.delivered).toBe(false);
      expect(second.reason).toMatch(/cooldown/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Still REPORTED as firing, and named as suppressed — the sweep must not
      // start answering "nothing is wrong" just because it went quiet.
      expect(second.firing.map((f) => f.name)).toContain('queue_backlog');
      expect(second.suppressed).toContain('queue_backlog');
    });

    it('a FAILED delivery does not start the cooldown', async () => {
      // The sharpest case: if the window opened at send time, a webhook outage
      // would silence the rule for an hour — the failure suppressing the very
      // alert that would have revealed it.
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
      const svc = firingSvc('60');

      const first = await svc.sweep();
      const second = await svc.sweep();

      expect(first.delivered).toBe(false);
      expect(second.delivered).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a cooldown of 0 disables suppression entirely', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const svc = firingSvc('0');

      await svc.sweep();
      const second = await svc.sweep();

      expect(second.delivered).toBe(true);
      expect(second.suppressed).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('an unreachable cooldown store never silences an alert', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const redis = {
        exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };
      const svc = new AlertDispatchService(
        registryWith(queueRule.threshold + 1),
        configWith('https://hook', '60'),
        redis as never,
      );

      const result = await svc.sweep();

      // Fails OPEN. Treating an unreadable store as "already notified" would
      // let a Redis blip take the alerting channel down with it.
      expect(result.delivered).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
