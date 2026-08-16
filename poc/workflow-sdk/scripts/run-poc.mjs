/**
 * POC ONLY — NOT PRODUCTION.
 *
 * The POC driver. It owns the server process, so "kill the process" means a real
 * SIGKILL of a real Node process, not a simulated one. Every assertion is read
 * back from disk (the append-only ledger and the provider's own state file) or
 * from the SDK's own run API — never from anything this script kept in memory.
 *
 * Usage:  node scripts/run-poc.mjs [--only POC-04]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EVIDENCE = resolve(ROOT, 'evidence');
const PORT = 4300;
const BASE = `http://localhost:${PORT}`;

const ENV = {
  ...process.env,
  WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
  WORKFLOW_POSTGRES_URL: 'postgres://wfpoc:wfpoc@localhost:5433/workflow_poc',
  PORT: String(PORT),
};

const results = [];
let server = null;
let serverGeneration = 0;

// ── plumbing ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

async function healthy() {
  try {
    const res = await fetch(`${BASE}/poc/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await healthy()) return;
  serverGeneration += 1;
  const gen = serverGeneration;
  server = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT,
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(d.toString()));
  server.stderr.on('data', (d) => log.push(d.toString()));
  server.on('exit', (code, signal) => {
    console.log(`  [server gen${gen}] exited code=${code} signal=${signal}`);
    writeFileSync(resolve(EVIDENCE, `server-gen${gen}.log`), log.join(''), 'utf8');
    if (server && server.pid === undefined) server = null;
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await healthy()) {
      console.log(`  [server gen${gen}] up pid=${server.pid}`);
      return;
    }
    await sleep(500);
  }
  writeFileSync(resolve(EVIDENCE, `server-gen${gen}.log`), log.join(''), 'utf8');
  throw new Error('server did not come up');
}

/** A REAL kill. SIGKILL so no shutdown hook can flush anything. */
async function killServer(why) {
  if (!server || server.exitCode !== null) {
    console.log(`  [kill] ${why} — process was already dead`);
    server = null;
    return;
  }
  console.log(`  [kill] SIGKILL pid=${server.pid} — ${why}`);
  // taskkill /T so graphile-worker's children go too.
  spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await healthy())) break;
    await sleep(300);
  }
  server = null;
  await sleep(1500);
}

async function waitForServerExit(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await healthy())) return true;
    await sleep(300);
  }
  return false;
}

async function pollRun(runId, want, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (await healthy()) {
      try {
        last = await req(`/poc/run/${runId}?await=1`);
        if (want.includes(last.status)) return last;
      } catch {
        /* server may be mid-restart */
      }
    }
    await sleep(1000);
  }
  return last ?? { status: 'TIMEOUT' };
}

function ledger(kind) {
  const p = resolve(EVIDENCE, 'ledger.jsonl');
  if (!existsSync(p)) return [];
  const all = readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return kind ? all.filter((e) => e.kind === kind) : all;
}

function providerState() {
  const p = resolve(EVIDENCE, 'external-api-state.json');
  if (!existsSync(p)) return { honoured: {}, requests: [] };
  return JSON.parse(readFileSync(p, 'utf8'));
}

function faults() {
  const p = resolve(EVIDENCE, 'faults.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8'));
}

function report(id, capability, pass, evidence, note) {
  const verdict = pass === true ? 'PASS' : pass === false ? 'FAIL' : 'NOT VERIFIED';
  results.push({ id, capability, verdict, evidence, note });
  console.log(`\n${verdict.padEnd(12)} ${id} — ${capability}`);
  console.log(`             ${JSON.stringify(evidence)}`);
  if (note) console.log(`             note: ${note}`);
}

// ── the cases ───────────────────────────────────────────────────────────────

async function poc01() {
  const { runId } = await req('/poc/01-basic', { method: 'POST', body: JSON.stringify({}) });
  const run = await pollRun(runId, ['completed', 'failed']);
  const order = run.returnValue?.order;
  report(
    'POC-01',
    'Basic durable workflow execution',
    run.status === 'completed' && JSON.stringify(order) === JSON.stringify(['A', 'B', 'C']),
    { sdkRunId: runId, status: run.status, order, result: run.returnValue?.result },
  );
}

async function poc02() {
  const runKey = `retry-${Date.now()}`;
  const { runId } = await req('/poc/02-retry', { method: 'POST', body: JSON.stringify({ runKey }) });
  const run = await pollRun(runId, ['completed', 'failed'], 120_000);
  const attempts = ledger('poc02.attempt').filter((e) => e.runKey === runKey);
  const stepIds = [...new Set(attempts.map((a) => a.stepId))];
  report(
    'POC-02',
    'Retry with real injected failures',
    run.status === 'completed' && attempts.length === 3 && stepIds.length === 1,
    {
      status: run.status,
      realAttempts: attempts.length,
      distinctStepIds: stepIds.length,
      returned: run.returnValue,
    },
    'stepId is stable across attempts — usable as a provider idempotency key.',
  );

  // 02b — FatalError must not be retried.
  const fatalKey = `fatal-${Date.now()}`;
  const fatal = await req('/poc/02-retry', {
    method: 'POST',
    body: JSON.stringify({ runKey: fatalKey, fatal: true }),
  });
  const fatalRun = await pollRun(fatal.runId, ['completed', 'failed'], 60_000);
  const fatalAttempts = ledger('poc02.fatal.attempt').filter((e) => e.runKey === fatalKey);
  report(
    'POC-02b',
    'FatalError is not retried',
    fatalRun.status === 'failed' && fatalAttempts.length === 1,
    { status: fatalRun.status, attempts: fatalAttempts.length },
  );
}

async function poc03() {
  const runKey = `wait-${Date.now()}`;
  const { runId } = await req('/poc/03-wait', {
    method: 'POST',
    body: JSON.stringify({ runKey, sleepFor: '5s' }),
  });
  // Confirm it really suspended rather than blocking a worker.
  await sleep(2000);
  const mid = await req(`/poc/run/${runId}`);
  const run = await pollRun(runId, ['completed', 'failed'], 90_000);
  const f = faults();
  report(
    'POC-03',
    'Durable wait (sleep) suspends and resumes',
    run.status === 'completed' &&
      f[`poc03:before:${runKey}`] === 1 &&
      f[`poc03:after:${runKey}`] === 1,
    {
      statusDuringSleep: mid.status,
      finalStatus: run.status,
      beforeExecutions: f[`poc03:before:${runKey}`],
      afterExecutions: f[`poc03:after:${runKey}`],
    },
  );
}

async function poc04() {
  const runKey = `restart-${Date.now()}`;
  const { runId } = await req('/poc/03-wait', {
    method: 'POST',
    body: JSON.stringify({ runKey, sleepFor: '25s' }),
  });

  // Wait until the FIRST step really committed, so the kill lands inside the sleep.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && (faults()[`poc03:before:${runKey}`] ?? 0) === 0) {
    await sleep(500);
  }
  const beforeKill = faults()[`poc03:before:${runKey}`] ?? 0;

  await killServer('POC-04: kill while the run is suspended in sleep()');
  const killedAt = Date.now();
  await startServer();

  const run = await pollRun(runId, ['completed', 'failed'], 120_000);
  const f = faults();
  report(
    'POC-04',
    'Crash / restart recovery',
    run.status === 'completed' &&
      f[`poc03:before:${runKey}`] === 1 &&
      f[`poc03:after:${runKey}`] === 1,
    {
      stepsCompletedBeforeKill: beforeKill,
      restartedAfterMs: Date.now() - killedAt,
      finalStatus: run.status,
      beforeExecutions: f[`poc03:before:${runKey}`],
      afterExecutions: f[`poc03:after:${runKey}`],
    },
    'A re-executed first step would show beforeExecutions > 1.',
  );
}

async function poc05(useKey, id) {
  const runKey = `${useKey ? 'sfx-key' : 'sfx-nokey'}-${Date.now()}`;
  const { runId } = await req('/poc/05-side-effect', {
    method: 'POST',
    body: JSON.stringify({ runKey, useIdempotencyKey: useKey }),
  });

  // The step kills the process itself, right after the provider call commits.
  const died = await waitForServerExit(60_000);
  await killServer('POC-05: ensure the process is gone');
  await startServer();

  const run = await pollRun(runId, ['completed', 'failed'], 120_000);
  const p = providerState();
  const mine = p.requests.filter((r) => JSON.stringify(r.payload).includes(runKey));
  const honoured = mine.filter((r) => !r.deduplicated).length;
  const dupes = mine.filter((r) => r.deduplicated).length;
  const distinctResources = new Set(
    mine.map((r) => (r.idempotencyKey ? p.honoured[r.idempotencyKey] : r.requestId)),
  ).size;

  report(
    id,
    useKey
      ? 'External side effect + crash, WITH provider idempotency key'
      : 'External side effect + crash, WITHOUT provider idempotency key',
    useKey ? run.status === 'completed' && distinctResources === 1 : null,
    {
      processReallyDied: died,
      finalStatus: run.status,
      providerRequestsReceived: mine.length,
      requestsHonoured: honoured,
      requestsDeduplicatedByProvider: dupes,
      distinctResourcesCreated: distinctResources,
      stepExecutions: faults()[`poc05:publish:${runKey}`],
    },
    useKey
      ? 'The SDK DID re-execute the step. Only the provider-side key stopped a second resource.'
      : 'Recorded, not scored: this measures how many duplicate calls the runtime issues.',
  );
}

async function poc06() {
  const triggerId = `test-trigger-001-${Date.now()}`;
  const [a, b] = await Promise.all([
    req('/poc/06-idempotency', { method: 'POST', body: JSON.stringify({ triggerId }) }),
    req('/poc/06-idempotency', { method: 'POST', body: JSON.stringify({ triggerId }) }),
  ]);
  const [ra, rb] = await Promise.all([
    pollRun(a.runId, ['completed', 'failed'], 90_000),
    pollRun(b.runId, ['completed', 'failed'], 90_000),
  ]);
  const p = providerState();
  const mine = p.requests.filter((r) => JSON.stringify(r.payload).includes(triggerId));
  const honoured = mine.filter((r) => !r.deduplicated).length;
  const statuses = [ra.returnValue?.status, rb.returnValue?.status].sort();

  report(
    'POC-06',
    'Duplicate trigger deduplication',
    honoured === 1,
    {
      runsStarted: 2,
      sdkRunIds: [a.runId, b.runId],
      outcomes: statuses,
      providerRequests: mine.length,
      sideEffectsHonoured: honoured,
    },
    'There is no start(..., {idempotencyKey}). Dedup is a hook-token protocol the caller writes.',
  );
}

async function poc07() {
  const runId = `orlixa-run-${Date.now()}`;
  const started = await req('/poc/07-dynamic', {
    method: 'POST',
    body: JSON.stringify({ runId, version: 'v1' }),
  });
  const run = await pollRun(started.runId, ['completed', 'failed'], 90_000);
  const visited = run.returnValue?.visited;
  report(
    'POC-07',
    'Dynamic (JSON-defined) workflow execution',
    run.status === 'completed' &&
      JSON.stringify(visited) === JSON.stringify(['n_trigger', 'n_draft', 'n_check', 'n_publish']),
    { status: run.status, visited, pinnedVersion: run.returnValue?.pinnedVersionId },
    'One generic "use workflow" interpreter; the graph is an argument, not code.',
  );
}

async function poc08() {
  // Run A on v2 (has a WAIT + APPROVAL), then run B on v1 WHILE A is suspended.
  const runIdA = `pin-A-${Date.now()}`;
  const a = await req('/poc/07-dynamic', {
    method: 'POST',
    body: JSON.stringify({ runId: runIdA, version: 'v2' }),
  });
  await sleep(4000);
  const runIdB = `pin-B-${Date.now()}`;
  const b = await req('/poc/07-dynamic', {
    method: 'POST',
    body: JSON.stringify({ runId: runIdB, version: 'v1' }),
  });
  const rb = await pollRun(b.runId, ['completed', 'failed'], 90_000);

  // A is parked on its approval — that is itself the proof it is still on v2.
  const approvals = await req('/poc/approvals');
  const pendingForA = approvals.find?.((r) => r.runId === runIdA && r.status === 'PENDING');

  report(
    'POC-08',
    'Version pinning (immutable WorkflowVersion per run)',
    Boolean(pendingForA) &&
      JSON.stringify(rb.returnValue?.visited) ===
        JSON.stringify(['n_trigger', 'n_draft', 'n_check', 'n_publish']),
    {
      runA: { orlixaRunId: runIdA, sdkRunId: a.runId, version: 'v2', parkedOnApproval: Boolean(pendingForA) },
      runB: { orlixaRunId: runIdB, sdkRunId: b.runId, version: 'v1', visited: rb.returnValue?.visited },
    },
    'Pinning holds because the graph is DATA. The SDK pins to a DEPLOYMENT, which is a different axis.',
  );
  return { runIdA, sdkRunIdA: a.runId };
}

async function poc09(pinned) {
  // The approval is pending. Kill the process, restart, and only THEN decide.
  await killServer('POC-09: kill while the run is suspended on an approval hook');
  await startServer();

  const afterRestart = await req('/poc/approvals');
  const stillPending = afterRestart.find?.((r) => r.runId === pinned.runIdA && r.status === 'PENDING');
  const runBefore = await req(`/poc/run/${pinned.sdkRunIdA}`);

  const decided = await req(`/poc/approvals/${encodeURIComponent(pinned.runIdA + ':n_approve')}/decide`, {
    method: 'POST',
    body: JSON.stringify({ approved: true, decidedBy: 'manager@company-poc' }),
  });
  const run = await pollRun(pinned.sdkRunIdA, ['completed', 'failed'], 120_000);
  const p = providerState();
  const publishes = p.requests.filter((r) => JSON.stringify(r.payload).includes(pinned.runIdA));

  report(
    'POC-09',
    'Approval suspend → survive restart → resume',
    Boolean(stillPending) &&
      runBefore.status !== 'completed' &&
      run.status === 'completed' &&
      publishes.filter((r) => !r.deduplicated).length === 1,
    {
      pendingAfterRestart: Boolean(stillPending),
      runStatusBeforeDecision: runBefore.status,
      resumedSdkRunId: decided.sdkRunId,
      finalStatus: run.status,
      visited: run.returnValue?.visited,
      publishCallsHonoured: publishes.filter((r) => !r.deduplicated).length,
    },
    'The approval RECORD is Orlixa\'s; the SDK only owns the hook token.',
  );
}

async function poc10() {
  const runId = `authz-deny-${Date.now()}`;
  const before = providerState().requests.length;
  const started = await req('/poc/07-dynamic', {
    method: 'POST',
    body: JSON.stringify({ runId, version: 'authz', employeeId: 'emp-unauthorized' }),
  });
  const run = await pollRun(started.runId, ['completed', 'failed'], 120_000);
  const p = providerState();
  const leaked = p.requests.slice(before).filter((r) => JSON.stringify(r.payload).includes(runId));
  const denials = ledger('authz.decision').filter((e) => e.employeeId === 'emp-unauthorized' && !e.allowed);

  report(
    'POC-10',
    'Authorization boundary is not bypassed',
    run.status === 'failed' && leaked.length === 0 && denials.length > 0,
    {
      finalStatus: run.status,
      providerCallsLeaked: leaked.length,
      denialsRecorded: denials.length,
    },
    'A denial is thrown inside the step, so the SDK retries it as if transient — see report §11.',
  );
}

async function poc11() {
  // Observability: what does the SDK expose about a run/step, and can Orlixa ids
  // be recovered from it?
  const runId = `obs-${Date.now()}`;
  const started = await req('/poc/07-dynamic', {
    method: 'POST',
    body: JSON.stringify({ runId, version: 'v1' }),
  });
  const run = await pollRun(started.runId, ['completed', 'failed'], 90_000);
  const stepMeta = ledger('dyn.ai_step').filter((e) => e.orlixaRunId === runId);
  report(
    'POC-11',
    'Observability metadata',
    run.status === 'completed' && stepMeta.length === 1,
    {
      sdkExposes: ['runId', 'status', 'returnValue', 'stepId (getStepMetadata)'],
      sampleStepMetadata: stepMeta[0] ?? null,
    },
    'Correlation to Orlixa ids only exists because the interpreter carries them in the payload.',
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(EVIDENCE)) mkdirSync(EVIDENCE, { recursive: true });
  for (const f of ['ledger.jsonl', 'external-api-state.json', 'faults.json', 'approvals.json']) {
    rmSync(resolve(EVIDENCE, f), { force: true });
  }

  await startServer();
  try {
    await poc01();
    await poc02();
    await poc03();
    await poc04();
    await poc05(true, 'POC-05');
    await poc05(false, 'POC-05b');
    await poc06();
    await poc07();
    const pinned = await poc08();
    await poc09(pinned);
    await poc10();
    await poc11();
  } finally {
    writeFileSync(
      resolve(EVIDENCE, 'results.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
      'utf8',
    );
    await killServer('suite finished');
  }

  console.log('\n================ SUMMARY ================');
  for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.id}  ${r.capability}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
