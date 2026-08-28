#!/usr/bin/env node
/**
 * Post-deploy smoke test — does the thing we just shipped actually exist?
 *
 * ## Why this exists
 *
 * `platform-api` served stale code for 32 days. The app was up, `/health`
 * returned 200, and every dashboard was green — but `POST /auth/verify-email`
 * answered 404, so no user could complete signup. "The server responds" and
 * "the deployment worked" are different claims, and only the first was ever
 * checked.
 *
 * So this asserts that specific routes EXIST, not that the process is alive.
 *
 * ## The rule that makes it trustworthy
 *
 * For a guarded route, 401/403 is a PASS: the request reached the handler's
 * guard, which proves the route is registered. Only 404 is a failure. We
 * therefore never need credentials, and the check stays read-only.
 *
 * ## The trap this avoids
 *
 * A parameterised route silently absorbs unrelated paths. `GET /workflows/runs`
 * looks alive even on an ancient build, because `@Get(':id')` matches it with
 * id="runs" and the guard 401s before routing precision matters. During the
 * 2026-08-28 investigation that false positive briefly made a 4-week-old
 * deployment look current.
 *
 * Every path below is therefore chosen to be UNSHADOWABLE: either a literal
 * segment under a controller with no sibling `:param` at that depth, or a POST
 * where no `@Post(':id')` exists. Adding a path here means checking that.
 *
 * Usage:
 *   API_BASE_URL=https://api.orlixa.io node scripts/smoke-test.mjs
 */

const baseUrl = (process.env.API_BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('API_BASE_URL is required, e.g. API_BASE_URL=https://api.orlixa.io');
  process.exit(2);
}

const TIMEOUT_MS = 20_000;

/**
 * `expect` is the set of acceptable status codes.
 *
 * Keep this list to routes whose ABSENCE is a real incident. It is a
 * deployment check, not an API test suite — the e2e suite already covers
 * behaviour, and a long smoke list mostly buys flakiness.
 */
const CHECKS = [
  // Liveness. Necessary but, as we learned, nowhere near sufficient.
  { method: 'GET', path: '/health', expect: [200], note: 'process is up' },

  // The signup flow that was broken. These 404'd for 32 days.
  { method: 'POST', path: '/auth/verify-email', expect: [400, 401], note: 'email verification' },
  { method: 'POST', path: '/auth/resend-verification', expect: [400, 401], note: 'resend OTP' },
  { method: 'POST', path: '/auth/forgot-password', expect: [400, 401], note: 'password reset' },

  // Core auth. A 400 here means validation ran, so the route and its DTO exist.
  { method: 'POST', path: '/auth/login', expect: [400], note: 'login validation' },
  { method: 'GET', path: '/auth/me', expect: [401], note: 'session lookup' },

  // One leaf per major module. Each first segment belongs to exactly one
  // controller, so a 404 means that whole module is missing from the build.
  { method: 'GET', path: '/skills/catalog', expect: [401], note: 'skills' },
  { method: 'GET', path: '/knowledge/documents', expect: [401], note: 'knowledge' },
  { method: 'GET', path: '/analytics/overview', expect: [401], note: 'analytics' },
  { method: 'GET', path: '/billing/plans', expect: [401], note: 'billing' },
  { method: 'GET', path: '/onboarding/status', expect: [401], note: 'onboarding' },
  { method: 'GET', path: '/hr/leave', expect: [401, 403], note: 'HR' },
  { method: 'GET', path: '/workflow-templates', expect: [401], note: 'workflow templates' },
  { method: 'GET', path: '/product-context/dashboard', expect: [401], note: 'product context' },
];

async function check({ method, path, expect, note }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      // No body on purpose: we want the guard or the validation pipe to answer,
      // never a real side effect.
      headers: { 'content-type': 'application/json' },
    });
    return { method, path, note, status: res.status, ok: expect.includes(res.status), expect };
  } catch (err) {
    return {
      method,
      path,
      note,
      status: err.name === 'AbortError' ? 'timeout' : `error: ${err.message}`,
      ok: false,
      expect,
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const c of CHECKS) {
  // Sequential: a cold serverless function needs to boot once, and hitting it
  // with 14 parallel requests turns one cold start into fourteen.
  results.push(await check(c));
}

console.log(`\nSmoke test against ${baseUrl}\n`);
for (const r of results) {
  const mark = r.ok ? 'ok  ' : 'FAIL';
  console.log(
    `  ${mark} ${String(r.status).padEnd(8)} ${r.method.padEnd(5)} ${r.path.padEnd(34)} ${r.note}`,
  );
}

/**
 * Optional web check — skipped unless WEB_BASE_URL is set.
 *
 * On 2026-08-29 every API check above passed while the SITE was broken: the
 * frontend had been built with `NEXT_PUBLIC_API_URL="[SENSITIVE]"` inlined (see
 * scripts/assert-build-env.mjs), so the browser posted to
 * `/[SENSITIVE]/auth/register` and registration 404'd. A green API smoke test
 * said nothing about it.
 *
 * `assert-build-env.mjs` now stops that before the build. This is the
 * after-the-fact half: it reads what was actually shipped.
 */
const webUrl = (process.env.WEB_BASE_URL || '').replace(/\/$/, '');
if (webUrl) {
  console.log(`\nWeb check against ${webUrl}\n`);
  try {
    const res = await fetch(`${webUrl}/register`, { redirect: 'follow' });
    const html = await res.text();
    // The value is inlined into a JS chunk, not the HTML, so follow the chunks.
    const chunks = [...html.matchAll(/\/_next\/static\/[^"']+\.js/g)]
      .map((m) => m[0])
      .slice(0, 20);
    let leaked = false;
    for (const c of new Set(chunks)) {
      const js = await fetch(`${webUrl}${c}`).then((r) => r.text());
      if (js.includes('[SENSITIVE]')) {
        leaked = true;
        console.log(`  FAIL  "[SENSITIVE]" is baked into ${c}`);
        break;
      }
    }
    if (leaked) {
      console.log(
        '\n  A Vercel variable marked Sensitive was inlined into the client\n' +
          '  bundle as the literal string "[SENSITIVE]". Turn OFF "Sensitive"\n' +
          '  for the NEXT_PUBLIC_* variables and redeploy.\n',
      );
      process.exit(1);
    }
    console.log(`  ok    ${res.status}     /register served, no redacted values in ${chunks.length} chunk(s)`);
  } catch (err) {
    console.log(`  FAIL  could not check the site: ${err.message}`);
    process.exit(1);
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
  console.log(`\n  All ${results.length} checks passed.\n`);
  process.exit(0);
}

console.log(`\n${failed.length} of ${results.length} checks FAILED:\n`);
for (const f of failed) {
  const missing = f.status === 404;
  console.log(
    `  ${f.method} ${f.path} -> ${f.status} (wanted ${f.expect.join(' or ')})` +
      (missing
        ? '\n    404 means the route is not in the running build. The deployment is\n' +
          '    stale or partial — the code you expect is not what is serving traffic.\n'
        : '\n'),
  );
}
process.exit(1);
