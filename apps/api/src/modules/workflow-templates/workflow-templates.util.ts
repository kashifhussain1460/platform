import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type {
  TemplateParameter,
  VariableType,
  WorkflowDefinition,
  WorkflowTemplateManifest,
} from '@vaep/types';
import { validateDefinitionStructure } from '../workflows/engine/definition-validator';
import { resolveTemplate } from '../workflows/engine/template';

/**
 * Pure helpers for workflow-template parameterisation + validation (P3-02).
 * Placeholders use the EXISTING `{{param.<key>}}` syntax (doc 19 §6.3) — the same
 * resolver as doc 06, not a second templating system.
 */

/** Matches a `{{param.<key>}}` reference anywhere inside a string. */
const PARAM_REF_RE = /\{\{\s*param\.([\w]+)\s*\}\}/g;
/** Matches a string that is EXACTLY a single `{{param.<key>}}` (whole-value). */
const WHOLE_PARAM_RE = /^\{\{\s*param\.([\w]+)\s*\}\}$/;

/** Collect every `{{param.x}}` key referenced anywhere in a JSON value. */
export function collectParamRefs(
  value: unknown,
  acc = new Set<string>(),
): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PARAM_REF_RE)) {
      acc.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectParamRefs(item, acc);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectParamRefs(item, acc);
  }
  return acc;
}

/**
 * Deep-substitute `{{param.x}}` placeholders with concrete values. A string that
 * is EXACTLY one placeholder yields the raw typed value (so a number param stays
 * a number); an embedded placeholder is string-interpolated via the doc-06
 * resolver. Runtime refs like `{{trigger.x}}` are NOT param refs and pass through
 * untouched for the engine to resolve at run time.
 */
export function substituteParams(
  value: unknown,
  params: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_PARAM_RE);
    if (whole) {
      return params[whole[1]];
    }
    // Only interpolate if it actually contains a param ref; otherwise return the
    // string verbatim so runtime `{{...}}` refs are preserved exactly.
    PARAM_REF_RE.lastIndex = 0;
    if (!PARAM_REF_RE.test(value)) {
      return value;
    }
    return resolveTemplate(value, { param: params });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteParams(item, params));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteParams(item, params);
    }
    return out;
  }
  return value;
}

/** A type-appropriate placeholder used ONLY for publish-time structural validation. */
export function dummyValueForType(type: VariableType): unknown {
  switch (type) {
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'json':
      return {};
    case 'array':
      return [];
    case 'date':
      return '2026-01-01T00:00:00.000Z';
    case 'string':
    case 'secret':
    default:
      return 'placeholder';
  }
}

/**
 * Publish-time validation (doc 19 §10). Throws BadRequestException listing every
 * problem: undeclared/unused params, a definition that fails normal graph
 * validation once params are substituted by type (this is what rejects a
 * third-party `DB_QUERY` node or an inline secret), or an unknown required skill.
 */
export function validateManifest(
  manifest: WorkflowTemplateManifest,
  validSkillKeys: ReadonlySet<string>,
): void {
  const problems: string[] = [];
  const declaredKeys = manifest.parameters.map((p) => p.key);

  const seen = new Set<string>();
  for (const key of declaredKeys) {
    if (seen.has(key)) {
      problems.push(`Parameter "${key}" is declared more than once`);
    }
    seen.add(key);
  }

  const refs = collectParamRefs(manifest.definition);
  for (const ref of refs) {
    if (!declaredKeys.includes(ref)) {
      problems.push(`Definition references undeclared parameter "${ref}"`);
    }
  }
  for (const key of declaredKeys) {
    if (!refs.has(key)) {
      problems.push(`Declared parameter "${key}" is never used in the definition`);
    }
  }

  // Substitute by declared type and run the SAME structural validation a
  // user-authored graph passes — rejects unknown node types (DB_QUERY) + inline
  // secrets (V11).
  const dummies: Record<string, unknown> = {};
  for (const param of manifest.parameters) {
    dummies[param.key] =
      param.default !== undefined ? param.default : dummyValueForType(param.type);
  }
  try {
    validateDefinitionStructure(
      substituteParams(manifest.definition, dummies) as WorkflowDefinition,
    );
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  for (const skill of manifest.requires.skills) {
    if (!validSkillKeys.has(skill)) {
      problems.push(`requires.skills lists unknown skill "${skill}"`);
    }
  }

  if (problems.length > 0) {
    throw new BadRequestException(
      `Workflow template "${manifest.key}@${manifest.version}" is invalid:\n` +
        problems.map((p) => `• ${p}`).join('\n'),
    );
  }
}

/** Assert supplied install parameters satisfy the template's declared params. */
export function resolveInstallParameters(
  parameters: TemplateParameter[],
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};

  for (const param of parameters) {
    const provided = supplied[param.key];
    const hasProvided = provided !== undefined && provided !== null;
    if (!hasProvided) {
      if (param.default !== undefined) {
        values[param.key] = param.default;
      } else if (param.required) {
        errors.push(`Missing required parameter "${param.key}"`);
      }
      continue;
    }
    if (!valueMatchesType(provided, param.type)) {
      errors.push(
        `Parameter "${param.key}" must be of type ${param.type}`,
      );
      continue;
    }
    values[param.key] = provided;
  }

  if (errors.length > 0) {
    // 422 — the request was well-formed but the parameters don't satisfy the
    // template contract (doc 19 §25-26 "parameter type mismatch → 422").
    throw new UnprocessableEntityException(errors.join('; '));
  }
  return values;
}

function valueMatchesType(value: unknown, type: VariableType): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'json':
      return typeof value === 'object';
    case 'string':
    case 'secret':
    case 'date':
      return typeof value === 'string';
    default:
      return true;
  }
}
