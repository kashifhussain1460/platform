export const PLANE_ENV = { BASE_URL: 'PLANE_BASE_URL' } as const;

/** WAVE 3 §3.5 — Plane's inbound webhook seam. */
export const PLANE_PROVIDER = 'plane';
/**
 * Plane signs with a plain hex HMAC-SHA256 of the raw body in this header — no
 * timestamp component, unlike Chatwoot's `timestamp.body` scheme in the sibling
 * Support engine. Never assume the two are interchangeable.
 */
export const PLANE_SIGNATURE_HEADER = 'x-plane-signature';
