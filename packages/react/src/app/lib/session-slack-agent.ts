/**
 * The Slack agent a chat was started for, read from the chat's metadata.
 *
 * Mirrors `sessionSlackAgent` from `@opengeni/contracts` without zod, so the
 * chat header (an eager module) does not load the contracts schemas. The
 * parity test keeps the two in step.
 */
export type SessionSlackAgentInfo = { id: string; name: string };

/** Session metadata key, `SESSION_SLACK_AGENT_METADATA_KEY` in contracts. */
const KEY = "slackAgent";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export function sessionSlackAgentInfo(
  metadata: Record<string, unknown> | null | undefined,
): SessionSlackAgentInfo | null {
  const value = metadata?.[KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  return { id, name };
}
