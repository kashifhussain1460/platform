import { findMissingRequiredArgs, resolveArgs, resolveTemplate } from './template';

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

describe('findMissingRequiredArgs', () => {
  // From a real failed run: an event-driven recruiting workflow was started by
  // hand, so the trigger step produced `{}`. `{{trigger_new_application.email}}`
  // became '' and Gmail answered "400: Recipient address required" — a message
  // that named neither the step, the field, nor the empty placeholder.
  const REQUIRED = ['to', 'subject', 'body'];

  it('reports a required arg whose placeholder had no value, and names the path', () => {
    const raw = { to: '{{trigger_new_application.email}}', subject: 'Hi', body: 'Hello' };
    const resolved = resolveArgs(raw, { trigger_new_application: {} });

    const missing = findMissingRequiredArgs(
      raw,
      resolved,
      { trigger_new_application: {} },
      REQUIRED,
    );
    expect(missing).toEqual([
      { arg: 'to', refs: ['trigger_new_application.email'] },
    ]);
  });

  it('says nothing when every required arg resolved', () => {
    const context = { trigger: { email: 'a@b.co' } };
    const raw = { to: '{{trigger.email}}', subject: 'Hi', body: 'Hello' };
    expect(
      findMissingRequiredArgs(raw, resolveArgs(raw, context), context, REQUIRED),
    ).toEqual([]);
  });

  it('leaves OPTIONAL args alone even when they resolve to nothing', () => {
    // An absent `cc` must keep behaving exactly as before — turning every
    // unresolved placeholder into a failure would break working workflows.
    const raw = { to: 'a@b.co', subject: 'Hi', body: 'Hello', cc: '{{nope.x}}' };
    expect(
      findMissingRequiredArgs(raw, resolveArgs(raw, {}), {}, REQUIRED),
    ).toEqual([]);
  });

  it('reports a required arg the author simply left blank, with no paths', () => {
    const raw = { to: '   ', subject: 'Hi', body: 'Hello' };
    expect(findMissingRequiredArgs(raw, resolveArgs(raw, {}), {}, REQUIRED)).toEqual([
      { arg: 'to', refs: [] },
    ]);
  });

  it('does not blame a secret ref — those resolve later, at the connector', () => {
    const raw = { to: '{{secret.inbox}}', subject: 'Hi', body: 'Hello' };
    const missing = findMissingRequiredArgs(raw, resolveArgs(raw, {}), {}, REQUIRED);
    // The value is still present (the literal placeholder), so nothing is missing.
    expect(missing).toEqual([]);
  });

  it('lists every missing required arg, not just the first', () => {
    const raw = { to: '{{t.email}}', subject: '{{t.subject}}', body: 'Hello' };
    const missing = findMissingRequiredArgs(raw, resolveArgs(raw, {}), {}, REQUIRED);
    expect(missing.map((m) => m.arg)).toEqual(['to', 'subject']);
  });
});
