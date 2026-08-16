/**
 * POC-06 — duplicate trigger. POC ONLY, NOT PRODUCTION.
 *
 * The SDK has no `start(fn, args, { idempotencyKey })`. The documented way to
 * deduplicate two starts is a hook token: the first run to suspend claims the
 * token, the second observes a conflict and returns without doing the work.
 *
 * This file implements exactly that so the POC can measure how well it holds —
 * including whether the documented race window is real.
 */
import { createHook, getStepMetadata } from 'workflow';
import { record } from '../orlixa/recorder';
import { executeSkill } from '../orlixa/skill-executor';

export async function pocIdempotentTrigger(triggerId: string) {
  'use workflow';

  const hook = createHook<{ noop: true }>({ token: `orlixa:trigger:${triggerId}` });
  const conflict = await hook.getConflict();

  if (conflict) {
    hook.dispose();
    await noteDuplicate(triggerId, conflict.runId);
    return { status: 'DUPLICATE', ownerRunId: conflict.runId };
  }

  const result = await doTheWork(triggerId);
  hook.dispose();
  return { status: 'PROCESSED', result };
}

async function doTheWork(triggerId: string) {
  'use step';
  const meta = getStepMetadata();
  return executeSkill({
    companyId: 'company-poc',
    employeeId: 'emp-authorized',
    runId: `trigger-${triggerId}`,
    nodeId: 'n_publish',
    skillTool: 'postiz.publish_now',
    args: { channel: 'linkedin', triggerId },
    idempotencyKey: meta.stepId,
    executionId: meta.stepId,
  });
}

async function noteDuplicate(triggerId: string, ownerRunId: string) {
  'use step';
  record('poc06.duplicate_detected', { triggerId, ownerRunId });
}
