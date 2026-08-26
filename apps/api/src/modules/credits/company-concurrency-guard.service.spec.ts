import { ConfigService } from '@nestjs/config';
import { CompanyConcurrencyGuardService } from './company-concurrency-guard.service';

function makeService(maxConcurrent: number): CompanyConcurrencyGuardService {
  const config = {
    get: (key: string) => (key === 'COMPANY_MAX_CONCURRENT_EXECUTIONS' ? String(maxConcurrent) : undefined),
  } as unknown as ConfigService;
  // redis: null exercises the in-memory fallback path directly and
  // deterministically — no real Redis dependency for this unit test.
  return new CompanyConcurrencyGuardService(null, config);
}

describe('CompanyConcurrencyGuardService', () => {
  it('the (N+1)th concurrent execution for one company is rejected while N execute normally', async () => {
    const guard = makeService(3);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => guard.tryAcquire('company-a')),
    );
    const accepted = results.filter(Boolean).length;
    const rejected = results.filter((r) => !r).length;
    expect(accepted).toBe(3);
    expect(rejected).toBe(2);
    expect(await guard.current('company-a')).toBe(3);
  });

  it('releasing frees a slot for the next acquire', async () => {
    const guard = makeService(1);
    expect(await guard.tryAcquire('company-b')).toBe(true);
    expect(await guard.tryAcquire('company-b')).toBe(false);
    await guard.release('company-b');
    expect(await guard.tryAcquire('company-b')).toBe(true);
  });

  it('another company is unaffected — the cap is per-company, never global', async () => {
    const guard = makeService(1);
    expect(await guard.tryAcquire('company-c')).toBe(true);
    expect(await guard.tryAcquire('company-c')).toBe(false);
    // A different company's cap is independent.
    expect(await guard.tryAcquire('company-d')).toBe(true);
  });

  it('release never goes below zero', async () => {
    const guard = makeService(1);
    await guard.release('company-e');
    await guard.release('company-e');
    expect(await guard.current('company-e')).toBe(0);
  });
});
