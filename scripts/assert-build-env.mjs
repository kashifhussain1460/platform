#!/usr/bin/env node
/**
 * Guard: no BUILD-TIME variable may be marked Sensitive in Vercel.
 *
 * ## The bug this exists to prevent
 *
 * `vercel pull` does not return the value of a variable marked Sensitive — it
 * writes the literal string `[SENSITIVE]`. `vercel build` then reads that file.
 *
 * On Vercel's own infrastructure this never matters, because the real values are
 * available inside their build container. It matters enormously when the build
 * runs anywhere else — which is exactly what `.github/workflows/deploy.yml` does.
 *
 * Next.js inlines every `NEXT_PUBLIC_*` value into the client bundle at BUILD
 * time. So on 2026-08-29, with `NEXT_PUBLIC_API_URL` marked Sensitive, the
 * shipped JavaScript contained the string `[SENSITIVE]` as the API base URL and
 * every browser request went to:
 *
 *     https://www.orlixa.io/[SENSITIVE]/auth/register   -> 404
 *
 * Registration was broken for real users, the build was green, and the API-side
 * smoke test passed because the API itself was perfectly healthy.
 *
 * ## Why marking these Sensitive is always wrong, not just inconvenient
 *
 * A `NEXT_PUBLIC_*` value is compiled into JavaScript that is served to every
 * visitor. It is readable by anyone with devtools, by definition. Marking it
 * Sensitive buys zero secrecy and costs a broken build, so the right fix is
 * always to unmark it — never to work around this check.
 *
 * Runtime-only variables (everything the API reads through ConfigService) are
 * unaffected: Vercel injects the real values into the running function, so they
 * SHOULD stay Sensitive.
 *
 * Usage:
 *   node scripts/assert-build-env.mjs <path-to-pulled-env-file>
 */

import { readFileSync } from 'node:fs';

const REDACTED = '[SENSITIVE]';

/**
 * Prefixes whose values are baked into build output rather than read at runtime.
 * Add to this list if another build-time-inlined convention appears; do not add
 * runtime variables, which are legitimately Sensitive.
 */
const BUILD_TIME_PREFIXES = ['NEXT_PUBLIC_', 'VITE_'];

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/assert-build-env.mjs <env-file>');
  process.exit(2);
}

let contents;
try {
  contents = readFileSync(file, 'utf8');
} catch {
  // No pulled file means nothing to check — the caller's own `vercel pull`
  // step would already have failed.
  console.log(`assert-build-env: ${file} not found, nothing to check.`);
  process.exit(0);
}

const redacted = [];
let checked = 0;

for (const line of contents.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!match) continue;
  const [, name, rawValue] = match;
  if (!BUILD_TIME_PREFIXES.some((p) => name.startsWith(p))) continue;
  checked += 1;
  const value = rawValue.trim().replace(/^"|"$/g, '');
  if (value === REDACTED) redacted.push(name);
}

if (redacted.length === 0) {
  console.log(
    `assert-build-env: ${checked} build-time variable(s) checked, none redacted.`,
  );
  process.exit(0);
}

console.error(`
Build-time variables are marked Sensitive in Vercel:

${redacted.map((n) => `  - ${n}`).join('\n')}

\`vercel pull\` returns "${REDACTED}" for these instead of the real value, and the
build would inline that literal string into the shipped bundle. The site would
deploy green and then send every request to a URL containing "${REDACTED}".

Fix: in the Vercel dashboard, edit each variable and turn OFF "Sensitive".

These are compiled into client-side JavaScript and served to every visitor, so
marking them Sensitive provides no secrecy at all — it only breaks builds that
run outside Vercel's own infrastructure.
`);
process.exit(1);
