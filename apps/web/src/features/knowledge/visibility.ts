import { formatRole } from '@/features/employees/labels';
import type { EmployeeRole } from './schemas';

/**
 * Who can read an uploaded document.
 *
 * ## Why this is a THREE-state choice, not two
 *
 * The API models visibility as `category?: EmployeeRole` where `undefined` means
 * "shared with everyone". That is fine as a wire format but dangerous as a UI
 * default, because "I haven't chosen yet" and "share it with the whole company"
 * end up as the same value — so a salary band or a disciplinary letter uploaded
 * by someone who never touched the dropdown becomes readable by every AI
 * Employee, silently.
 *
 * `''` (UNCHOSEN) exists to keep those two apart. Screens that have a safe
 * default (an employee's own Knowledge tab defaults to that employee's role)
 * never show it; the global Knowledge page starts there and refuses to upload
 * until a human has actually decided.
 */
export type VisibilityChoice = EmployeeRole | 'SHARED' | '';

export const UNCHOSEN: VisibilityChoice = '';

/** Map the UI choice onto the API's `category` argument. */
export function toCategory(choice: VisibilityChoice): EmployeeRole | undefined {
  return choice === '' || choice === 'SHARED' ? undefined : choice;
}

/** True when the user still has to decide. Uploads must be blocked until then. */
export function isUnchosen(choice: VisibilityChoice): boolean {
  return choice === '';
}

/**
 * Plain-language consequence of a choice.
 *
 * Deliberately states who CAN read it rather than naming the scope: "HR" tells
 * an admin nothing about the risk, "Only HR AI Employees can read this" tells
 * them exactly what they are agreeing to.
 */
export function visibilityHelp(choice: VisibilityChoice): string {
  if (choice === '') {
    return 'Choose who can read this before uploading.';
  }
  if (choice === 'SHARED') {
    return 'Every AI Employee in your company can read these documents.';
  }
  return `Only ${formatRole(choice)} AI Employees can read these documents.`;
}

/**
 * The same consequence, phrased for an AI Employee's OWN Knowledge tab.
 *
 * On that page there is no decision to make — the document belongs to that
 * employee — so the sentence names the PERSON rather than the role enum. "These
 * go to Anushka" is what the uploader is actually thinking; "HR" is an
 * implementation detail they have to translate.
 */
export function ownerVisibilityHelp(
  ownerName: string,
  choice: VisibilityChoice,
): string {
  if (choice === 'SHARED') {
    return `${ownerName} and every other AI Employee can read these.`;
  }
  if (choice === '') {
    return visibilityHelp(choice);
  }
  return `${ownerName} and any other ${formatRole(choice)} AI Employee can read these.`;
}

/**
 * True when moving from `from` to `to` WIDENS access.
 *
 * Only widening is worth confirming. Narrowing (Shared → HR) can never expose
 * anything, so asking about it would be the kind of prompt people learn to
 * click through — which is exactly what makes the dangerous one ineffective.
 */
export function isWidening(from: VisibilityChoice, to: VisibilityChoice): boolean {
  return to === 'SHARED' && from !== 'SHARED' && from !== '';
}
