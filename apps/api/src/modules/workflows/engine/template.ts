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
