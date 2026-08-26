import type { SkillExecutionSupport } from '@vaep/types';

/**
 * THE declared list of `(skill, tool)` pairs that `RealSkillExecutor` genuinely
 * implements against a live provider.
 *
 * ## Why this exists
 *
 * `RealSkillExecutor.execute()` ends in `default: return this.fallback.execute(...)`
 * — the MOCK. That is a sensible offline default and a dangerous production one:
 * hubspot, jira, github and stripe all have catalog entries, and two of them
 * (hubspot, jira) have working OAuth. A customer could authorise their real
 * HubSpot, see `connectionStatus: CONNECTED`, run a workflow that "creates a
 * contact", get `ok: true` — and nothing whatsoever would have reached HubSpot.
 * `stripe.create_payment_link` is worse: it is `highRisk`, so a human is asked
 * to approve a payment link that is then fabricated.
 *
 * This registry makes that reachable as data instead of buried in a `switch`:
 * the catalog can label a skill SIMULATED, the UI can warn before a user relies
 * on it, and the executor can fail closed rather than invent a success.
 *
 * ## Keeping it honest
 *
 * `real-execution-support.spec.ts` asserts (a) every pair here exists in the
 * code catalog, and (b) every pair here is a real `case` in
 * `real-skill-executor.ts`, read from the source file. Adding a `case` without
 * adding it here — or the reverse — fails the build. Same drift-guard pattern
 * as `capabilities.spec.ts` and `node-catalog.spec.ts`.
 */
export const REAL_EXECUTION_TOOLS: readonly string[] = [
  'slack.send_message',
  'http.request',
  'gmail.send_email',
  'email.send_email',
  'calendar.create_event',
  'gdrive.upload_file',
  'gdrive.create_folder',
  'gdrive.move_file',
  'gdrive.list_files',
  'gdrive.read_file',
  'scheduling.claim_slot',
  'scheduling.reschedule_slot',
  'postiz.list_connected_accounts',
  'postiz.start_connect_account',
  'postiz.schedule_post',
  'postiz.publish_now',
  'postiz.get_post_status',
  'postiz.get_post_analytics',
  'chatwoot.list_open_conversations',
  'chatwoot.get_conversation',
  'chatwoot.reply_to_conversation',
  'chatwoot.resolve_conversation',
  'plane.list_issues',
  'plane.create_issue',
  'plane.update_issue_status',
  'marketing.check_consent',
] as const;

const REAL_TOOL_SET: ReadonlySet<string> = new Set(REAL_EXECUTION_TOOLS);

/**
 * Skills with NO real executor at all. Derived, not hand-written — but exported
 * so a test can assert the four known offenders are still named here and nobody
 * "fixes" the audit by quietly deleting the flag instead of the gap.
 */
export function skillsWithNoRealExecution(allSkillKeys: readonly string[]): string[] {
  return allSkillKeys.filter((key) => !hasAnyRealExecution(key));
}

/** True when this exact tool reaches a live provider. */
export function isRealExecutionSupported(skillKey: string, tool: string): boolean {
  return REAL_TOOL_SET.has(`${skillKey}.${tool}`);
}

/** True when at least one of the skill's tools reaches a live provider. */
export function hasAnyRealExecution(skillKey: string): boolean {
  const prefix = `${skillKey}.`;
  for (const ref of REAL_TOOL_SET) {
    if (ref.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Classify a skill for the catalog DTO.
 *
 * `toolNames` is the skill's full tool list, so PARTIAL is honest: `gmail` has a
 * real `send_email` and a mock `read_inbox`, and calling that skill "REAL"
 * would be the same over-claim this whole file exists to stop.
 */
export function executionSupportFor(
  skillKey: string,
  toolNames: readonly string[],
): SkillExecutionSupport {
  if (toolNames.length === 0) return 'SIMULATED';
  const real = toolNames.filter((tool) => isRealExecutionSupported(skillKey, tool)).length;
  if (real === 0) return 'SIMULATED';
  return real === toolNames.length ? 'REAL' : 'PARTIAL';
}
