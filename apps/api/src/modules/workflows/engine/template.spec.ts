import { resolveArgs, resolveTemplate } from './template';

describe('template resolver — secret namespace (runtime-verification D2)', () => {
  it('resolves ordinary paths', () => {
    expect(resolveTemplate('{{trigger.x}}', { trigger: { x: 'v' } })).toBe('v');
  });

  it('leaves {{secret.NAME}} UNTOUCHED so the secret resolver can handle it', () => {
    // Regression: TEMPLATE_RE used to consume `secret.apiToken`, blanking it to
    // '' before SecretResolverService ran — the tool then called with no cred.
    expect(resolveTemplate('{{secret.apiToken}}', {})).toBe('{{secret.apiToken}}');
    expect(resolveTemplate('{{ secret.apiToken }}', {})).toBe(
      '{{ secret.apiToken }}',
    );
  });

  it('resolveArgs preserves secret refs but still resolves ordinary refs', () => {
    const out = resolveArgs(
      { to: '{{trigger.email}}', token: '{{secret.apiToken}}' },
      { trigger: { email: 'a@b.co' } },
    );
    expect(out).toEqual({ to: 'a@b.co', token: '{{secret.apiToken}}' });
  });
});
