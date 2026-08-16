/**
 * POC-05 — external side effect + a crash in the unsafe window.
 * POC ONLY, NOT PRODUCTION.
 *
 * The step:
 *   1. calls the external provider (the side effect COMMITS),
 *   2. then hard-kills the process before the result can be reported.
 *
 * This is the one window no durable-execution engine can close without
 * provider-side two-phase commit. The question the POC answers is not "does it
 * happen" (it must) but "what does the runtime do next, and does the
 * idempotency key hold".
 *
 * Two variants so the two halves can be separated:
 *   - `withKey`   passes stepId as the provider idempotency key
 *   - `withoutKey` passes none, so a duplicate call is visible as a duplicate
 */
import { getStepMetadata } from 'workflow';
import { bump, hardCrash, seen } from '../orlixa/fault';
import { record } from '../orlixa/recorder';
import { executeSkill } from '../orlixa/skill-executor';

export async function pocSideEffect(runKey: string, useIdempotencyKey: boolean) {
  'use workflow';

  const published = await publishThenCrash(runKey, useIdempotencyKey);
  const confirmed = await confirmPublished(runKey, published);
  return { published, confirmed };
}

async function publishThenCrash(runKey: string, useIdempotencyKey: boolean) {
  'use step';
  const meta = getStepMetadata();
  const execution = bump(`poc05:publish:${runKey}`);

  record('poc05.step.enter', {
    runKey,
    execution,
    stepId: meta.stepId,
    useIdempotencyKey,
    pid: process.pid,
  });

  // ── THE SIDE EFFECT — it really commits at the provider ──────────────────
  const result = executeSkill({
    companyId: 'company-poc',
    employeeId: 'emp-authorized',
    runId: runKey,
    nodeId: 'n_publish',
    skillTool: 'postiz.publish_now',
    args: { channel: 'linkedin', body: `post for ${runKey}` },
    // stepId is stable across retries — the SDK's documented idempotency key.
    idempotencyKey: useIdempotencyKey ? meta.stepId : '',
    executionId: `${meta.stepId}#${execution}`,
  });

  // ── CRASH, only the first time, AFTER the effect committed ────────────────
  if (seen(`poc05:crashed:${runKey}`) === 0) {
    bump(`poc05:crashed:${runKey}`);
    hardCrash(`POC-05: killing the process after the provider call for ${runKey}`);
  }

  record('poc05.step.exit', { runKey, execution, resourceId: result.resourceId });
  return result;
}

async function confirmPublished(runKey: string, published: { resourceId: string }) {
  'use step';
  record('poc05.confirm', { runKey, resourceId: published.resourceId });
  return { confirmedAt: new Date().toISOString() };
}
