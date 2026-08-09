/**
 * Orlixa AI Assist tuning knobs (doc 30 §6.3 / §26). Every one is a hard cap on
 * something that can otherwise run away — an agent loop, a token bill, or a
 * conversation. Defaults are deliberately conservative; override via env.
 */

/** Tool calls the agent may make within ONE turn before it must answer. */
export const ASSIST_MAX_ITERATIONS = 12;

/** Turns in one session before the user is asked to start a fresh one. */
export const ASSIST_MAX_TURNS = 60;

/** Output tokens per session; over this the session goes EXHAUSTED. */
export const ASSIST_SESSION_TOKEN_BUDGET = 400_000;

/** How long a dry-run self-test may take before it is reported as TIMED_OUT. */
export const ASSIST_TEST_TIMEOUT_MS = 60_000;

/** Recent messages kept verbatim in the prompt (older ones get summarised). */
export const ASSIST_CONTEXT_MESSAGES = 30;

/** Session title is derived from the opening prompt, clipped to this. */
export const ASSIST_TITLE_MAX = 80;

/** Usage-metering source tag, so assist spend is separable from chat spend. */
export const ASSIST_USAGE_SOURCE = 'assist';
