/**
 * Tiny, safe template resolver for workflow node configs. Supports `{{a.b.c}}`
 * dotted-path lookups into the mutable run `context`. There is intentionally NO
 * eval / expression language — only literal path traversal — so a workflow
 * definition can never execute arbitrary code.
 */

/** Placeholder syntax: `{{ path.into.context }}` (whitespace tolerated). */
const TEMPLATE_RE = /\{\{\s*([\w.$]+)\s*\}\}/g;

/** Safe, prototype-free traversal of `path` (dot-separated) into `context`. */
export function lookup(
  context: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    // Guard against prototype-pollution style keys.
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Stringify a looked-up value for interpolation (objects → JSON). */
function stringifyValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Resolve every `{{path}}` in `template` against `context`. Non-string inputs
 * are returned as-is (coerced to ''). Missing paths resolve to an empty string.
 */
export function resolveTemplate(
  template: unknown,
  context: Record<string, unknown>,
): string {
  if (typeof template !== 'string') {
    return template == null ? '' : String(template);
  }
  return template.replace(TEMPLATE_RE, (match, path: string) => {
    // Leave the `{{secret.NAME}}` namespace UNTOUCHED — it is resolved later and
    // only at the connector boundary by SecretResolverService (P2-01). Consuming
    // it here would blank the placeholder (context has no `secret` key), so the
    // secret would silently resolve to '' and the tool would call with no
    // credential. Secret refs are safe to leave as literals; they are never a
    // value, and anything persisted keeps the reference, not the secret.
    if (path === 'secret' || path.startsWith('secret.')) {
      return match;
    }
    return stringifyValue(lookup(context, path));
  });
}

/** A required argument that came out of templating with nothing in it. */
export interface MissingArg {
  /** The argument name, e.g. `to`. */
  arg: string;
  /**
   * The `{{paths}}` in that argument that had no value in this run. Empty when
   * the author simply left the field blank rather than referencing anything.
   */
  refs: string[];
}

/**
 * Required arguments that resolved to nothing.
 *
 * `resolveTemplate` turns an unknown path into an empty string, which is the
 * right call for an optional field and a trap for a required one: the step then
 * calls the provider with `to: ""` and the customer gets back a vendor error
 * ("Gmail API error (400): Recipient address required") that names neither the
 * step, the argument, nor the placeholder that came up empty.
 *
 * Only REQUIRED arguments are reported — an optional `cc` that resolves to ''
 * keeps behaving exactly as it did.
 */
export function findMissingRequiredArgs(
  rawArgs: Record<string, unknown> | undefined,
  resolvedArgs: Record<string, unknown>,
  context: Record<string, unknown>,
  required: string[],
): MissingArg[] {
  const missing: MissingArg[] = [];
  for (const arg of required) {
    const value = resolvedArgs[arg];
    const isBlank =
      value == null || (typeof value === 'string' && value.trim() === '');
    if (!isBlank) {
      continue;
    }
    missing.push({ arg, refs: unresolvedRefs(rawArgs?.[arg], context) });
  }
  return missing;
}

/** The `{{paths}}` inside one raw template whose value is absent from `context`. */
function unresolvedRefs(
  raw: unknown,
  context: Record<string, unknown>,
): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  const refs: string[] = [];
  for (const match of raw.matchAll(TEMPLATE_RE)) {
    const path = match[1];
    // Secret refs are resolved later at the connector boundary, so "absent from
    // context" says nothing about them.
    if (path === 'secret' || path.startsWith('secret.')) {
      continue;
    }
    if (lookup(context, path) == null) {
      refs.push(path);
    }
  }
  return refs;
}

/** Resolve every value of a `{ key: template }` map into a string map. */
export function resolveArgs(
  args: Record<string, unknown> | undefined,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  if (!args) {
    return resolved;
  }
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = resolveTemplate(value, context);
  }
  return resolved;
}
