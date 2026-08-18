/**
 * The SKILL PROVIDER ADAPTER contract (enterprise skill-connection plan §28).
 *
 * The plan's §1 decision is that Orlixa must NOT treat every skill as
 * `Install → API Key → Save`. Provider-specific complexity belongs behind one
 * contract so the frontend can stay a single sequential wizard (§26) and Orlixa
 * keeps owning authorization, approval, tenant isolation, audit and idempotency
 * (§40).
 *
 * ## Why this is opt-in per skill
 *
 * `getProviderAdapter()` returns `null` for a skill that has no adapter yet, and
 * every caller treats null as "behave exactly as before". That is deliberate:
 * the strict verify-before-READY gate (§37) changes what `connect` DOES, and
 * switching thirteen integrations to it at once — most of which are still mock
 * executors with no way to validate anything — would break connecting for all of
 * them to fix one. Adapters are added one provider at a time, each with its own
 * live verification, exactly as §36's waves describe.
 *
 * ## What an adapter must never do
 *
 * Return credentials, or anything derived from them, in `detail`. These strings
 * are surfaced to the user and written to the audit trail (§4, §32).
 */

/** Failure vocabulary from §3. A verify step reports one of these on failure. */
export type ConnectionFailureCode =
  | 'AUTH_FAILED'
  | 'INVALID_CREDENTIALS'
  | 'INSUFFICIENT_SCOPE'
  | 'ACCOUNT_NOT_FOUND'
  | 'CONNECTION_FAILED'
  | 'TEST_FAILED'
  | 'WEBHOOK_FAILED'
  | 'HEALTH_CHECK_FAILED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'DEGRADED'
  | 'ERROR';

/** The stages of §3's state machine that an adapter can be asked to perform. */
export type VerifyStepKey =
  | 'credentials'
  | 'account'
  | 'outbound'
  | 'inbound'
  | 'health';

export interface VerifyStep {
  key: VerifyStepKey;
  /** Human label for the wizard row, e.g. "Sign in to the mail server". */
  label: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  /** Why it failed, or what it found. NEVER a credential. */
  detail?: string;
  code?: ConnectionFailureCode;
}

/** What one adapter call reports back. */
export interface AdapterCheck {
  ok: boolean;
  /** Failure reason, safe to show a user and to store in audit metadata. */
  detail?: string;
  code?: ConnectionFailureCode;
  /**
   * True when the adapter could not perform a REAL check and assumed success —
   * mirrors `HealthProbeResult.mock`. An assumed pass must never be presented
   * as a verified one.
   */
  assumed?: boolean;
}

/** Everything an adapter needs. `creds` is already decrypted by the caller. */
export interface AdapterInput {
  creds: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface DiscoveredAccount {
  /** The external identity this connection acts as, e.g. `hr@company.com`. */
  account: string | null;
  /** Non-secret provider facts worth storing/displaying. */
  metadata?: Record<string, unknown>;
}

/**
 * One provider's implementation. Only `key` and `validateCredentials` are
 * required — a provider that cannot cheaply discover an account or run a
 * non-destructive test simply omits those, and the runner records the stage as
 * SKIPPED rather than inventing a pass.
 */
export interface SkillProviderAdapter {
  /** Catalog skillKey this adapter serves. */
  readonly key: string;

  /**
   * §3 AUTHENTICATING → AUTHENTICATED. A real authenticated handshake with the
   * provider. This is the check that makes `connect` mean something.
   */
  validateCredentials(input: AdapterInput): Promise<AdapterCheck>;

  /** §3 DISCOVERING_ACCOUNT — which external identity did we just connect? */
  discoverAccount?(input: AdapterInput): Promise<DiscoveredAccount>;

  /**
   * §3 TESTING — a real, non-destructive action proving the connection works
   * end to end. An adapter whose only test would have a side effect (sending
   * mail to a stranger) must require the caller to opt in via `opts`.
   *
   * `to` is an explicit override; `requesterEmail` is the connecting user's own
   * account email, always supplied by the caller — a provider with no notion of
   * "the connection's own address" (Slack) uses it as its natural default,
   * providers that DO have one (email, Gmail) ignore it and keep defaulting to
   * themselves.
   */
  test?(input: AdapterInput, opts?: { to?: string; requesterEmail?: string }): Promise<AdapterCheck>;

  /**
   * §3 CONFIGURING_INBOUND — can this connection RECEIVE?
   *
   * Separate from `validateCredentials` because inbound and outbound are
   * genuinely different capabilities on the same connection (§10 tests both):
   * a mailbox can be perfectly able to send while its IMAP settings are wrong,
   * and a workflow waiting on inbound email would then never fire while every
   * screen showed green.
   */
  validateInbound?(input: AdapterInput): Promise<AdapterCheck>;

  /** §33 — the cheap recurring liveness check. */
  healthCheck?(input: AdapterInput): Promise<AdapterCheck>;

  /** Map a thrown provider error onto the §3 vocabulary. */
  classifyError(error: unknown): ConnectionFailureCode;
}

/**
 * Registered adapters, keyed by catalog skillKey.
 *
 * Populated by `registerProviderAdapter` at module load (see
 * `providers/index.ts`) rather than by importing every adapter here, so adding a
 * provider touches one file and cannot create an import cycle back into the
 * skills module.
 */
const ADAPTERS = new Map<string, SkillProviderAdapter>();

export function registerProviderAdapter(adapter: SkillProviderAdapter): void {
  ADAPTERS.set(adapter.key, adapter);
}

/** The adapter for a skill, or null when the skill has none (see header). */
export function getProviderAdapter(
  skillKey: string,
): SkillProviderAdapter | null {
  return ADAPTERS.get(skillKey) ?? null;
}

/** Every skillKey that currently has a real adapter. Used by tests + status. */
export function adapterKeys(): string[] {
  return [...ADAPTERS.keys()].sort();
}

/**
 * Run the §3 stages in order and stop at the first failure.
 *
 * Sequential and short-circuiting on purpose: "a connection cannot become READY
 * until all required stages pass" (§3), and running a test send against
 * credentials that already failed to authenticate produces a second, more
 * confusing error for the same root cause.
 */
export async function runVerification(
  adapter: SkillProviderAdapter,
  input: AdapterInput,
  opts: { includeTest: boolean; testTo?: string; requesterEmail?: string } = { includeTest: false },
): Promise<{
  ok: boolean;
  steps: VerifyStep[];
  account: string | null;
  code?: ConnectionFailureCode;
}> {
  const steps: VerifyStep[] = [];
  let account: string | null = null;

  // ── Stage 1: credentials ────────────────────────────────────────────────
  const creds = await safely(
    () => adapter.validateCredentials(input),
    adapter,
  );
  steps.push({
    key: 'credentials',
    label: 'Sign in to the provider',
    status: creds.ok ? 'PASSED' : 'FAILED',
    detail: creds.detail,
    code: creds.code,
  });
  if (!creds.ok) {
    return { ok: false, steps, account, code: creds.code ?? 'AUTH_FAILED' };
  }

  // ── Stage 2: account discovery ──────────────────────────────────────────
  if (adapter.discoverAccount) {
    try {
      const found = await adapter.discoverAccount(input);
      account = found.account;
      steps.push({
        key: 'account',
        label: 'Identify the account',
        status: 'PASSED',
        detail: found.account ?? undefined,
      });
    } catch (error) {
      steps.push({
        key: 'account',
        label: 'Identify the account',
        status: 'FAILED',
        detail: message(error),
        code: adapter.classifyError(error),
      });
      return { ok: false, steps, account, code: 'ACCOUNT_NOT_FOUND' };
    }
  } else {
    steps.push({
      key: 'account',
      label: 'Identify the account',
      status: 'SKIPPED',
      detail: 'This provider does not expose an account lookup.',
    });
  }

  // ── Stage 3: inbound ────────────────────────────────────────────────────
  if (adapter.validateInbound) {
    const inbound = await safely(() => adapter.validateInbound!(input), adapter);
    steps.push({
      key: 'inbound',
      label: 'Receive email',
      // `assumed` means the adapter could not really check — for inbound that
      // is "not configured", which is a legitimate send-only connection, not a
      // pass to be celebrated and not a failure to be blocked on.
      status: inbound.ok ? (inbound.assumed ? 'SKIPPED' : 'PASSED') : 'FAILED',
      detail: inbound.detail,
      code: inbound.code,
    });
    if (!inbound.ok) {
      return { ok: false, steps, account, code: inbound.code ?? 'CONNECTION_FAILED' };
    }
  }

  // ── Stage 4: test action ────────────────────────────────────────────────
  if (!adapter.test) {
    steps.push({
      key: 'outbound',
      label: 'Run a test action',
      status: 'SKIPPED',
      detail: 'This provider has no non-destructive test.',
    });
  } else if (!opts.includeTest) {
    // Not run is not the same as passed. §37 is explicit that a connection is
    // only complete when it has been tested, so an untested connection has to
    // say so rather than quietly showing a tick.
    steps.push({
      key: 'outbound',
      label: 'Run a test action',
      status: 'SKIPPED',
      detail: 'Not requested.',
    });
  } else {
    const tested = await safely(
      () => adapter.test!(input, { to: opts.testTo, requesterEmail: opts.requesterEmail }),
      adapter,
    );
    steps.push({
      key: 'outbound',
      label: 'Run a test action',
      status: tested.ok ? 'PASSED' : 'FAILED',
      detail: tested.detail,
      code: tested.code,
    });
    if (!tested.ok) {
      return { ok: false, steps, account, code: tested.code ?? 'TEST_FAILED' };
    }
  }

  return { ok: true, steps, account };
}

/** Never let a provider's thrown error escape as a 500. */
async function safely(
  run: () => Promise<AdapterCheck>,
  adapter: SkillProviderAdapter,
): Promise<AdapterCheck> {
  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      detail: message(error),
      code: adapter.classifyError(error),
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}
