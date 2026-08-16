/**
 * POC-03 (durable wait) and POC-04 (crash/restart recovery).
 * POC ONLY, NOT PRODUCTION.
 *
 * One workflow serves both: the sleep is the durable state the process is
 * killed in the middle of.
 */
import { getStepMetadata, sleep } from 'workflow';
import { bump } from '../orlixa/fault';
import { record } from '../orlixa/recorder';

/**
 * POC-08b — the code-version marker. Flipped between two builds while a run is
 * suspended, to find out whether an in-flight run resumes into the code it
 * started on or into whatever was deployed last.
 */
const CODE_BUILD = 'A';

export async function pocWait(runKey: string, sleepFor: string) {
  'use workflow';

  const before = await beforeSleep(runKey);
  await sleep(sleepFor);
  const after = await afterSleep(runKey);
  return { before, after };
}

async function beforeSleep(runKey: string) {
  'use step';
  const meta = getStepMetadata();
  // Counted so a re-execution after a restart is visible rather than assumed.
  const executions = bump(`poc03:before:${runKey}`);
  record('poc03.before', { runKey, executions, stepId: meta.stepId, pid: process.pid });
  return { executions, at: new Date().toISOString() };
}

async function afterSleep(runKey: string) {
  'use step';
  const meta = getStepMetadata();
  const executions = bump(`poc03:after:${runKey}`);
  record('poc03.after', {
    runKey,
    executions,
    stepId: meta.stepId,
    pid: process.pid,
    build: CODE_BUILD,
  });
  return { executions, at: new Date().toISOString(), build: CODE_BUILD };
}
