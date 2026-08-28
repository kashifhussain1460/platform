#!/usr/bin/env node
/**
 * Production environment preflight.
 *
 * ## Why this exists
 *
 * On 2026-08-28 an audit of the live `platform-api` Vercel project found FIVE
 * configuration problems, none of which announced themselves:
 *
 *   - `MAIL_ENABLED` unset  -> MailService.generateOtp() returns the fixed dev
 *     code, so every signup OTP in production was `123456`. An auth bypass,
 *     shipped by omission.
 *   - `WORKFLOW_EXECUTION_MODE` unset -> with `QUEUE_WORKERS_ENABLED=false`
 *     there is no consumer AND no inline execution, so every workflow run is
 *     created and sits PENDING for ever (gap G40).
 *   - `CRON_SECRET` unset -> the `/admin/cron/*` routes disable themselves, so
 *     all 17 scheduled jobs silently never ran.
 *   - Preview reusing Production's `DATABASE_URL`.
 *   - No deploy in 32 days, because nothing checked.
 *
 * Every one is a *missing* value. Nothing crashed, no log said "misconfigured"
 * — the product just quietly did less than it claimed. That is the failure mode
 * this script exists to convert into a loud, blocking error.
 *
 * ## Scope
 *
 * It checks that values are PRESENT and internally CONSISTENT. It cannot check
 * that a secret is correct — only that a deployment which needs one has one.
 * Consistency is the interesting part: several of these are only wrong in
 * combination (workers off + queue mode = nothing executes), and a plain
 * "is it set?" list would have passed all five.
 *
 * Usage:
 *   node scripts/preflight-env.mjs              # checks process.env
 *   node scripts/preflight-env.mjs --warn-only  # report, never exit non-zero
 */

const argv = process.argv.slice(2);
const warnOnly = argv.includes('--warn-only');

const env = process.env;
const errors = [];
const warnings = [];
const unverifiable = [];

/**
 * `vercel env pull` does NOT return the values of variables marked Sensitive —
 * it writes the literal string `[SENSITIVE]` instead. On this project that is
 * 28 of 61 variables, including ENCRYPTION_KEY and DATABASE_URL.
 *
 * This bit me while writing the script: `[SENSITIVE]` is 11 characters, so the
 * "ENCRYPTION_KEY must be 64 hex chars" check fired and looked exactly like a
 * real, alarming finding — a production key that would throw at boot. It was
 * the placeholder. Acting on it would have meant rotating a live key and making
 * every stored credential undecryptable.
 *
 * So: a redacted value still counts as PRESENT (that much is true and useful),
 * but any check on its CONTENT must be skipped and reported as unverified.
 * Silently passing would be worse than either — it would claim a guarantee we
 * did not check.
 */
const REDACTED = '[SENSITIVE]';

/** Treat empty/whitespace as absent — `FOO=` in a dashboard is not a value. */
const isSet = (name) => typeof env[name] === 'string' && env[name].trim() !== '';
const get = (name) => (isSet(name) ? env[name].trim() : undefined);
const isRedacted = (name) => get(name) === REDACTED;

/**
 * Run a content check only when we can actually see the content.
 * Records the skip so the report never implies more than it verified.
 */
function checkValue(name, fn) {
  if (!isSet(name)) return;
  if (isRedacted(name)) {
    unverifiable.push(name);
    return;
  }
  fn(get(name));
}

function require_(name, why) {
  if (!isSet(name)) errors.push(`${name} is not set — ${why}`);
}

function warn(condition, message) {
  if (condition) warnings.push(message);
}

// ---------------------------------------------------------------------------
// Always required — the app cannot be correct without these.
// ---------------------------------------------------------------------------

require_('DATABASE_URL', 'the API cannot reach Postgres');
require_('JWT_ACCESS_SECRET', 'access tokens cannot be signed');
require_('JWT_REFRESH_SECRET', 'refresh tokens cannot be signed');
require_(
  'ENCRYPTION_KEY',
  'stored OAuth/SMTP credentials are AES-GCM encrypted at rest and cannot be read or written without it',
);

// 32 bytes, as 64 hex chars or base64 — matching CryptoService.resolveKey,
// which THROWS at boot on anything else. Getting this wrong takes the whole API
// down, so it is worth checking whenever the value is actually visible.
checkValue('ENCRYPTION_KEY', (key) => {
  const looksHex = /^[0-9a-fA-F]{64}$/.test(key);
  const base64Bytes = Buffer.from(key, 'base64').length;
  if (!looksHex && base64Bytes !== 32) {
    errors.push(
      'ENCRYPTION_KEY must be 64 hex characters or base64 encoding exactly 32 ' +
        `bytes (this decodes to ${base64Bytes}). CryptoService throws at boot on ` +
        'anything else, so the API would not start.',
    );
  }
});

// Identical secrets mean an access token also verifies as a refresh token,
// defeating the short access TTL. Only checkable when both are visible.
if (
  isSet('JWT_ACCESS_SECRET') &&
  isSet('JWT_REFRESH_SECRET') &&
  !isRedacted('JWT_ACCESS_SECRET') &&
  !isRedacted('JWT_REFRESH_SECRET') &&
  get('JWT_ACCESS_SECRET') === get('JWT_REFRESH_SECRET')
) {
  errors.push(
    'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical — an access token ' +
      'would then verify as a refresh token, defeating the short access TTL.',
  );
}

// ---------------------------------------------------------------------------
// Execution shape. These are only wrong TOGETHER, which is why they were missed.
// ---------------------------------------------------------------------------

const workersEnabled = get('QUEUE_WORKERS_ENABLED') === 'true';
const executionMode = get('WORKFLOW_EXECUTION_MODE');

if (!workersEnabled && executionMode !== 'inline') {
  errors.push(
    'QUEUE_WORKERS_ENABLED is not "true" and WORKFLOW_EXECUTION_MODE is not ' +
      `"inline" (it is ${executionMode ? `"${executionMode}"` : 'unset'}). ` +
      'This is gap G40: a serverless deployment has no BullMQ consumer, so every ' +
      'workflow run would be created and stay PENDING for ever. Set ' +
      'WORKFLOW_EXECUTION_MODE=inline for serverless, or run a worker.',
  );
}

if (workersEnabled && executionMode === 'inline') {
  errors.push(
    'QUEUE_WORKERS_ENABLED=true together with WORKFLOW_EXECUTION_MODE=inline ' +
      'double-fires SCHEDULE triggers: the cron sweep runs the workflow AND a ' +
      'reachable worker runs the BullMQ repeatable. Pick one.',
  );
}

// ---------------------------------------------------------------------------
// Scheduled work.
// ---------------------------------------------------------------------------

// Unset does not merely leave the routes open — it deliberately DISABLES them,
// so the failure is 17 jobs that never run rather than an error anyone sees.
require_(
  'CRON_SECRET',
  'the /admin/cron/* routes disable themselves when it is unset, so every ' +
    'scheduled job (schedules, watchdog, approval SLA, retention, inbound poll) ' +
    'silently never runs',
);

// ---------------------------------------------------------------------------
// Mail. The security-critical one.
// ---------------------------------------------------------------------------

const isProduction = get('NODE_ENV') === 'production';
const mailEnabled = get('MAIL_ENABLED') === 'true';

if (isProduction && !mailEnabled) {
  errors.push(
    'MAIL_ENABLED is not "true" in production. MailService.generateOtp() then ' +
      `returns the FIXED dev code (${get('DEV_OTP_CODE') || '123456'}), so anyone ` +
      'could verify any email address and complete a password reset. Set ' +
      'MAIL_ENABLED=true and the SMTP_* values, or do not deploy the verify-email flow.',
  );
}

if (mailEnabled) {
  require_('SMTP_HOST', 'mail is enabled but there is no server to send through');
  require_('SMTP_PORT', 'mail is enabled but no port is configured');
  require_('SMTP_USER', 'mail is enabled but there are no credentials');
  require_('SMTP_PASS', 'mail is enabled but there are no credentials');
  require_('MAIL_FROM', 'mail is enabled but messages would have no From address');
}

if (isProduction && isSet('DEV_OTP_CODE')) {
  errors.push('DEV_OTP_CODE is set in production — remove it; it pins every OTP to a known value.');
}

// ---------------------------------------------------------------------------
// Provider selection. Mock providers in production are the "silent success"
// defect class: the run goes green and nothing actually happened.
// ---------------------------------------------------------------------------

for (const [name, mockValue] of [
  ['SKILL_EXECUTOR', 'mock'],
  ['BILLING_PROVIDER', 'mock'],
  ['LLM_PROVIDER', 'mock'],
]) {
  if (isProduction && get(name) === mockValue) {
    errors.push(
      `${name}=${mockValue} in production — it reports success without doing ` +
        'anything real, which is indistinguishable from working.',
    );
  }
}

if (isProduction && !isSet('WEB_ORIGIN')) {
  warnings.push('WEB_ORIGIN is not set — CORS and emailed links may point at the wrong host.');
}

warn(
  isProduction && get('LLM_PROVIDER') === 'openai' && !isSet('OPENAI_API_KEY'),
  'LLM_PROVIDER=openai but OPENAI_API_KEY is not set — the first AI call will fail at runtime.',
);
warn(
  isProduction && get('LLM_PROVIDER') === 'anthropic' && !isSet('ANTHROPIC_API_KEY'),
  'LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — the first AI call will fail at runtime.',
);

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const label = isProduction ? 'production' : `NODE_ENV=${get('NODE_ENV') || 'unset'}`;
console.log(`\nEnvironment preflight (${label})\n`);

for (const w of warnings) console.log(`  WARN   ${w}\n`);
for (const e of errors) console.log(`  FAIL   ${e}\n`);

// Say plainly what was NOT checked. "Passed" must never be read as "verified"
// for a value this script was never able to see.
if (unverifiable.length > 0) {
  console.log(
    `  NOTE   ${unverifiable.length} value(s) are marked Sensitive in Vercel and came\n` +
      `         back as "${REDACTED}", so only their PRESENCE was checked, not their\n` +
      `         contents: ${unverifiable.join(', ')}\n`,
  );
}

if (errors.length === 0) {
  console.log(
    `  No blocking problems.${warnings.length ? ` ${warnings.length} warning(s).` : ''}\n`,
  );
  process.exit(0);
}

console.log(`${errors.length} blocking problem(s), ${warnings.length} warning(s).\n`);
if (warnOnly) {
  console.log('--warn-only: not failing the build.\n');
  process.exit(0);
}
process.exit(1);
