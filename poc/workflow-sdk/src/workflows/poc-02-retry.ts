/**
 * POC-02 — retry. POC ONLY, NOT PRODUCTION.
 *
 * The failure is REAL: attempts 1 and 2 throw, attempt 3 returns. The attempt
 * counter is file-backed so it cannot be reset by the runtime replaying the
 * workflow body.
 */
import { FatalError, getStepMetadata } from 'workflow';
import { bump } from '../orlixa/fault';
import { record } from '../orlixa/recorder';

export async function pocRetry(runKey: string) {
  'use workflow';

  const flaky = await flakyStep(runKey);
  return { flaky };
}

/** Fails twice for real, then succeeds. */
async function flakyStep(runKey: string) {
  'use step';
  const meta = getStepMetadata();
  const attempt = bump(`poc02:${runKey}`);
  record('poc02.attempt', { runKey, attempt, stepId: meta.stepId, meta });

  if (attempt < 3) {
    throw new Error(`Injected transient failure on attempt ${attempt}`);
  }
  return { attempts: attempt, stepId: meta.stepId };
}

/** POC-02b — a FatalError must NOT be retried. */
export async function pocFatal(runKey: string) {
  'use workflow';
  return await fatalStep(runKey);
}

async function fatalStep(runKey: string) {
  'use step';
  const attempt = bump(`poc02fatal:${runKey}`);
  record('poc02.fatal.attempt', { runKey, attempt });
  throw new FatalError('Injected non-retryable failure');
}
