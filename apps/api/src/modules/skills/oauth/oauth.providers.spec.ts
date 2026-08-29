import type { ConfigService } from '@nestjs/config';
import { resolveOAuthProvider } from './oauth.providers';

/**
 * Production outage, 2026-08-29: connecting Slack failed at Slack's own
 * authorize screen with "Invalid permissions requested" — before the customer
 * ever saw a consent screen, let alone got to choose.
 *
 * Per Slack's own docs (docs.slack.dev/reference/scopes/users.read.email):
 * "This scope must be requested at the same time as users:read." Our scope
 * list had `users:read.email` without `users:read`, so EVERY Slack connect
 * attempt was broken, not merely missing one capability.
 *
 * This pins the paired requirement so it cannot silently regress — e.g. if a
 * future edit reorders or "cleans up" the array without knowing why the pair
 * exists.
 */
describe('resolveOAuthProvider — slack scopes', () => {
  function fakeConfig(values: Record<string, string>): ConfigService {
    return { get: (key: string) => values[key] } as unknown as ConfigService;
  }

  const config = fakeConfig({
    OAUTH_SLACK_CLIENT_ID: 'client-id',
    OAUTH_SLACK_CLIENT_SECRET: 'client-secret',
    OAUTH_REDIRECT_BASE: 'https://api.orlixa.io',
  });

  it('never requests users:read.email without users:read', () => {
    const resolved = resolveOAuthProvider('slack', config);
    expect(resolved).not.toBeNull();
    if (resolved!.scopes.includes('users:read.email')) {
      expect(resolved!.scopes).toContain('users:read');
    }
  });

  it('requests exactly the scopes the app needs — chat:write, channels:read, users:read(.email)', () => {
    const resolved = resolveOAuthProvider('slack', config);
    expect(resolved!.scopes.sort()).toEqual(
      ['chat:write', 'channels:read', 'users:read', 'users:read.email'].sort(),
    );
  });
});
