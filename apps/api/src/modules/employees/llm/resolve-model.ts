/**
 * The ONE place a model id is decided.
 *
 * Precedence: the call's own `model` (an AI Employee's configured choice) →
 * `LLM_MODEL` → the provider's current default.
 *
 * ## Why it is a shared function rather than three copies
 *
 * There used to be two answers to "which model is this call using?" and they
 * disagreed. The providers resolved `config.get('LLM_MODEL') || DEFAULT_MODEL`;
 * the credit pricers resolved `process.env.LLM_MODEL ?? 'default'`. With
 * `LLM_MODEL` unset — the state a fresh deployment is in — a request went to
 * `gpt-5.6-terra` and was billed against a generic `default` rate row. Nothing
 * failed; the number was just wrong, which is the worst kind of billing defect.
 *
 * Both sides call this now, so a mismatch is impossible by construction: the
 * value that went to the vendor is the value that gets priced.
 *
 * `defaultModel` is passed in rather than imported so this stays provider-neutral
 * — OpenAI's and Anthropic's defaults are their own business, and this file has
 * no opinion about which vendor is configured.
 */
export function resolveModel(
  requested: string | undefined,
  envModel: string | undefined,
  defaultModel: string,
): string {
  const fromCall = requested?.trim();
  if (fromCall) return fromCall;
  const fromEnv = envModel?.trim();
  if (fromEnv) return fromEnv;
  return defaultModel;
}
