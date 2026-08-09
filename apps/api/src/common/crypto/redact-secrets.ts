const SECRET_MASK = '***';

/**
 * Replace every occurrence of a known secret VALUE inside `value` (recursing
 * through objects/arrays/strings) with `***`. Values shorter than 4 chars are
 * ignored to avoid masking common substrings. Pure + side-effect free so it can
 * scrub a persisted audit row or a returned tool result at one taint boundary.
 */
export function redactSecrets(value: unknown, secretValues: string[]): unknown {
  const secrets = secretValues.filter((s) => s && s.length >= 4);
  if (secrets.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      let out = node;
      for (const secret of secrets) out = out.split(secret).join(SECRET_MASK);
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v),
        ]),
      );
    }
    return node;
  };
  return walk(value);
}
