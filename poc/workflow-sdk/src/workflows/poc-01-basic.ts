/** POC-01 — basic durable execution. POC ONLY, NOT PRODUCTION. */
import { getStepMetadata } from 'workflow';
import { record } from '../orlixa/recorder';

export async function pocBasic(label: string) {
  'use workflow';

  const a = await stepA(label);
  const b = await stepB(a);
  const c = await stepC(b);
  return { label, order: [a.name, b.name, c.name], result: c.value };
}

async function stepA(label: string) {
  'use step';
  const meta = getStepMetadata();
  record('poc01.step', { name: 'A', label, stepId: meta.stepId });
  return { name: 'A', value: 1 };
}

async function stepB(prev: { name: string; value: number }) {
  'use step';
  const meta = getStepMetadata();
  record('poc01.step', { name: 'B', prev: prev.name, stepId: meta.stepId });
  return { name: 'B', value: prev.value + 1 };
}

async function stepC(prev: { name: string; value: number }) {
  'use step';
  const meta = getStepMetadata();
  record('poc01.step', { name: 'C', prev: prev.name, stepId: meta.stepId });
  return { name: 'C', value: prev.value + 1 };
}
