import { deliveryIdFor } from './event-normalize.processor';

/**
 * Which identity a workflow run is deduped by.
 *
 * Measured before this existed: one logical event delivered twice, the two
 * bodies differing only in a `deliveredAt` timestamp, ran the workflow **twice**.
 * RawEvent dedupe keys on a hash of the signed body — right for replay, useless
 * for a provider retry, which is almost never byte-identical. Anything with a
 * side effect on that workflow would have fired twice.
 */
describe('deliveryIdFor', () => {
  it('uses the provider delivery header, namespaced by provider', () => {
    expect(
      deliveryIdFor({ provider: 'http', headers: { 'x-event-id': 'evt-77' } }),
    ).toBe('http:evt-77');
  });

  it('namespaces so two providers cannot collide on the same counter', () => {
    // Both providers happily number their deliveries from 1.
    expect(deliveryIdFor({ provider: 'http', headers: { 'x-event-id': '1' } })).not.toBe(
      deliveryIdFor({ provider: 'github', headers: { 'x-github-delivery': '1' } }),
    );
  });

  it('reads each provider through its OWN driver, not one hardcoded header', () => {
    expect(
      deliveryIdFor({ provider: 'github', headers: { 'x-github-delivery': 'gh-9' } }),
    ).toBe('github:gh-9');
  });

  it('returns null when the provider sent no delivery id', () => {
    // The caller then falls back to the canonical row id — exactly the old
    // behaviour, so a provider without delivery ids is unaffected.
    expect(deliveryIdFor({ provider: 'http', headers: { 'content-type': 'application/json' } })).toBeNull();
  });

  it('survives headers that are absent or not an object', () => {
    expect(deliveryIdFor({ provider: 'http', headers: null })).toBeNull();
    expect(deliveryIdFor({ provider: 'http', headers: ['x'] as never })).toBeNull();
  });
});
