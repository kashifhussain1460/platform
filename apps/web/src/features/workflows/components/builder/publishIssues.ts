/**
 * Split the backend's publish-validation error into individual issues for a
 * readable list. The API (validateDefinitionStructure) returns EITHER a single
 * message, OR "Workflow definition has N problems:\n• [nodeId] msg\n• msg…". We
 * render the backend's authoritative text — no client re-implementation of the
 * rules (that would drift) — just formatted as a list.
 */
export function splitPublishIssues(message: string): string[] {
  if (!message) return [];
  const marker = message.match(/has \d+ problems?:\n/);
  if (!marker) return [message.trim()];
  const body = message.slice((marker.index ?? 0) + marker[0].length);
  return body
    .split('\n')
    .map((line) => line.replace(/^[•\-*]\s*/, '').trim())
    .filter(Boolean);
}
