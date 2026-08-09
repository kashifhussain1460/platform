import type { VariableScope, VariableType } from '@vaep/types';
import { lookup } from './template';

/**
 * P2-01 — variable scopes layered over the EXISTING `{{a.b.c}}` resolver.
 *
 * The resolver in `template.ts` is unchanged and still the only interpolation
 * path — there is deliberately no second templating system. This module adds
 * the scope BAG that a resolver reads from, and the rules about which scopes a
 * graph may write.
 *
 * Scope precedence when a bare `{{name}}` is resolved (most specific first):
 *   RUNTIME → INPUT → OUTPUT → WORKFLOW → GLOBAL → ENVIRONMENT
 *
 * SECRET is absent from that chain on purpose: a secret must never be
 * interpolated into a template, because the resolved string lands in step
 * output, run history and DLQ dumps. Secrets are referenced by
 * `WorkflowSecretRef` and resolved inside the connector layer at call time.
 */

/** Scope lookup order for an unqualified `{{name}}`. */
export const SCOPE_PRECEDENCE: readonly VariableScope[] = [
  'RUNTIME',
  'INPUT',
  'OUTPUT',
  'WORKFLOW',
  'GLOBAL',
  'ENVIRONMENT',
] as const;

export type VariableBag = Partial<Record<VariableScope, Record<string, unknown>>>;

export class SecretInterpolationError extends Error {
  constructor(name: string) {
    super(
      `Refusing to interpolate secret "${name}" into a template. ` +
        `Reference it through the connector's credentials instead — a resolved ` +
        `secret would be persisted into step output and run history.`,
    );
    this.name = 'SecretInterpolationError';
  }
}

export class ReadOnlyScopeError extends Error {
  constructor(scope: VariableScope) {
    super(
      `Scope ${scope} is read-only at runtime and cannot be written by a workflow.`,
    );
    this.name = 'ReadOnlyScopeError';
  }
}

/**
 * Build the flat context a template resolves against.
 *
 * Later scopes are applied FIRST so earlier (more specific) ones win, which
 * matches SCOPE_PRECEDENCE. Scope-qualified access (`{{vars.WORKFLOW.name}}`)
 * is also exposed so an author can be explicit when two scopes share a name.
 */
export function buildVariableContext(
  bag: VariableBag,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...base };

  for (const scope of [...SCOPE_PRECEDENCE].reverse()) {
    for (const [key, value] of Object.entries(bag[scope] ?? {})) {
      flat[key] = value;
    }
  }

  // Explicit, scope-qualified access. SECRET is excluded entirely — it is not
  // reachable from a template by any spelling.
  const qualified: Record<string, unknown> = {};
  for (const scope of SCOPE_PRECEDENCE) {
    if (bag[scope]) qualified[scope] = { ...bag[scope] };
  }
  flat.vars = qualified;

  return flat;
}

/**
 * Resolve a single variable by name through the precedence chain.
 * Throws if the name only exists in SECRET — failing loudly beats silently
 * resolving to an empty string and shipping a broken API call.
 */
export function resolveVariable(bag: VariableBag, name: string): unknown {
  for (const scope of SCOPE_PRECEDENCE) {
    const scoped = bag[scope];
    if (scoped && Object.prototype.hasOwnProperty.call(scoped, name)) {
      return scoped[name];
    }
  }
  if (
    bag.SECRET &&
    Object.prototype.hasOwnProperty.call(bag.SECRET, name)
  ) {
    throw new SecretInterpolationError(name);
  }
  return undefined;
}

/** Reject a write to a scope a workflow must not modify. */
export function assertWritableScope(scope: VariableScope): void {
  if (scope === 'SECRET' || scope === 'ENVIRONMENT') {
    throw new ReadOnlyScopeError(scope);
  }
  if (scope === 'INPUT' || scope === 'GLOBAL') {
    // INPUT is the run's immutable input; GLOBAL is company-level config. Both
    // are set outside the graph, so a node writing them would be surprising.
    throw new ReadOnlyScopeError(scope);
  }
}

/**
 * Coerce a value to its declared type, throwing on a genuine mismatch.
 *
 * Deliberately strict for numbers and dates: silently coercing an LLM reply
 * like "around 85" to NaN is how an already-started run takes the wrong branch.
 */
export function coerceVariable(value: unknown, type: VariableType): unknown {
  switch (type) {
    case 'string':
      return value == null ? '' : String(value);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw new Error(
          `Variable expected a number but got ${JSON.stringify(value)}`,
        );
      }
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error(
        `Variable expected a boolean but got ${JSON.stringify(value)}`,
      );
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(d.getTime())) {
        throw new Error(
          `Variable expected a date but got ${JSON.stringify(value)}`,
        );
      }
      return d.toISOString();
    }
    case 'array':
      if (Array.isArray(value)) return value;
      throw new Error(
        `Variable expected an array but got ${JSON.stringify(value)}`,
      );
    case 'json':
    case 'secret':
      return value;
    default:
      return value;
  }
}

/** Read a dotted path out of the built context (re-exported for handlers). */
export { lookup };
