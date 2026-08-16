/**
 * POC-08b — code-version pinning on a SELF-HOSTED world. POC ONLY.
 *
 * The SDK's documented guarantee is that "runs are pinned to the deployment that
 * starts them". This checks whether that guarantee actually exists off Vercel:
 *
 *   1. build with CODE_BUILD='A'  → start a run that suspends in sleep()
 *   2. kill the process
 *   3. edit the step, rebuild with CODE_BUILD='B'
 *   4. restart, let the run resume
 *   5. read the step's return value
 *
 * 'A' = pinned. 'B' = the in-flight run resumed into code it never started on.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'src/workflows/poc-03-wait.ts');
const BASE = 'http://localhost:4300';
const ENV = {
  ...process.env,
  WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
  WORKFLOW_POSTGRES_URL: 'postgres://wfpoc:wfpoc@localhost:5433/workflow_poc',
  PORT: '4300',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;

async function healthy() {
  try {
    return (await fetch(`${BASE}/poc/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function up() {
  server = spawn(process.execPath, ['dist/main.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(500);
  }
  throw new Error('server did not start');
}

async function down() {
  if (server) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await healthy())) await sleep(300);
  server = null;
  await sleep(1500);
}

function setBuild(letter) {
  const src = readFileSync(SRC, 'utf8').replace(/const CODE_BUILD = '[AB]'/, `const CODE_BUILD = '${letter}'`);
  writeFileSync(SRC, src, 'utf8');
  const built = spawnSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`build failed:\n${built.stdout}\n${built.stderr}`);
  console.log(`  built with CODE_BUILD='${letter}'`);
}

async function main() {
  setBuild('A');
  await up();

  const runKey = `pin08b-${Date.now()}`;
  const started = await (
    await fetch(`${BASE}/poc/03-wait`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runKey, sleepFor: '45s' }),
    })
  ).json();
  console.log(`  started ${started.runId} on build A`);

  // Let the first step commit so the run is genuinely suspended in sleep().
  await sleep(8000);
  await down();

  setBuild('B');
  await up();

  let result = null;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const r = await (await fetch(`${BASE}/poc/run/${started.runId}?await=1`)).json();
    if (r.status === 'completed' || r.status === 'failed') {
      result = r;
      break;
    }
    await sleep(2000);
  }

  const build = result?.returnValue?.after?.build ?? null;
  console.log('\nPOC-08b result:', JSON.stringify({ status: result?.status, resumedIntoBuild: build }));
  console.log(
    build === 'A'
      ? 'PINNED — the in-flight run kept its original code.'
      : build === 'B'
        ? 'NOT PINNED — the in-flight run resumed into code deployed after it started.'
        : 'INCONCLUSIVE',
  );

  writeFileSync(
    resolve(ROOT, 'evidence', 'poc-08b.json'),
    JSON.stringify(
      { runKey, sdkRunId: started.runId, status: result?.status, resumedIntoBuild: build },
      null,
      2,
    ),
    'utf8',
  );

  await down();
  setBuild('A');
}

main().catch(async (e) => {
  console.error(e);
  await down();
  process.exitCode = 1;
});
