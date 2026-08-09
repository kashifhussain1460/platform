import { redactSecrets } from './redact-secrets';

describe('redactSecrets (P1-8 taint boundary)', () => {
  it('masks a leaked secret in a nested provider error', () => {
    const echo = { error: '401 invalid token sk-live-abc123', meta: { k: 'sk-live-abc123' } };
    expect(redactSecrets(echo, ['sk-live-abc123'])).toEqual({
      error: '401 invalid token ***',
      meta: { k: '***' },
    });
  });

  it('ignores secrets shorter than 4 chars (avoids over-masking)', () => {
    expect(redactSecrets({ t: 'abcabc' }, ['abc'])).toEqual({ t: 'abcabc' });
  });

  it('returns the value unchanged when there are no secrets', () => {
    expect(redactSecrets('hello', [])).toBe('hello');
  });
});
