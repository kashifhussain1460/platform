import {
  SECRET_MASK,
  SecretResolverService,
  UnknownSecretRefError,
} from './secret-resolver.service';

const TOKEN = 'sk-live-abcdef123456';

function make(refs: Array<{ key: string; fieldName: string; creds: unknown }>) {
  const prisma = {
    workflowSecretRef: {
      findMany: jest.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        refs
          .filter((r) => where.key.in.includes(r.key))
          .map((r) => ({
            key: r.key,
            fieldName: r.fieldName,
            installedSkill: {
              skillKey: 'stripe',
              // Legacy-plaintext shape, which readCredentials accepts as-is —
              // keeps the test focused on resolution, not on encryption.
              credentials: r.creds,
            },
          })),
      ),
    },
  };
  // Never reached: the fixture uses the legacy-plaintext credential shape.
  const crypto = { decryptJson: () => ({}) };
  return new SecretResolverService(
    prisma as never,
    crypto as never,
  );
}

describe('SecretResolverService (P2-01)', () => {
  it('finds every {{secret.X}} reference nested anywhere', () => {
    const svc = make([]);
    const refs = svc.collectReferences({
      a: 'Bearer {{secret.apiToken}}',
      b: [{ c: '{{ secret.other }}' }],
      d: 42,
    });
    expect(refs.sort()).toEqual(['apiToken', 'other']);
  });

  it('substitutes the real credential value at call time', async () => {
    const svc = make([
      { key: 'apiToken', fieldName: 'apiKey', creds: { apiKey: TOKEN } },
    ]);
    const { resolved, used, secretValues } = await svc.resolve('c1', 'wf1', {
      header: 'Bearer {{secret.apiToken}}',
    });
    expect(resolved).toEqual({ header: `Bearer ${TOKEN}` });
    expect(used).toEqual(['apiToken']);
    // The VALUES come back too — masking needs them, and a secret is
    // substituted INTO a value, not stored under a key named after itself.
    expect(secretValues).toEqual([TOKEN]);
  });

  it('leaves a value with no references untouched and does not query', async () => {
    const svc = make([]);
    const value = { plain: 'nothing here' };
    const out = await svc.resolve('c1', 'wf1', value);
    expect(out.resolved).toBe(value);
    expect(out.secretValues).toEqual([]);
  });

  it('throws for an unregistered reference rather than substituting empty', async () => {
    // Substituting '' would send a credential-less request and surface as a
    // baffling 401 from the provider.
    const svc = make([]);
    await expect(
      svc.resolve('c1', 'wf1', { h: '{{secret.missing}}' }),
    ).rejects.toThrow(UnknownSecretRefError);
  });

  it('throws when the connector has no such credential field', async () => {
    const svc = make([
      { key: 'apiToken', fieldName: 'apiKey', creds: { somethingElse: 'x' } },
    ]);
    await expect(
      svc.resolve('c1', 'wf1', { h: '{{secret.apiToken}}' }),
    ).rejects.toThrow(/no credential field "apiKey"/);
  });

  it('masks a leaked secret out of anything about to be persisted', () => {
    const svc = make([]);
    const providerEcho = {
      ok: false,
      error: `Invalid key ${TOKEN} supplied`,
      nested: [{ detail: TOKEN }],
    };
    expect(svc.mask(providerEcho, [TOKEN])).toEqual({
      ok: false,
      error: `Invalid key ${SECRET_MASK} supplied`,
      nested: [{ detail: SECRET_MASK }],
    });
  });

  it('does not mask a short/empty value (too likely to be a false positive)', () => {
    const svc = make([]);
    expect(svc.mask({ t: 'abcabc' }, ['abc'])).toEqual({ t: 'abcabc' });
  });
});
