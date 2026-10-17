/**
 * Browser/React Native-safe learning-refusal fact. Deliberately free of the
 * zod runtime so synchronous timeline projection can read it.
 *
 * A durable learning write (a Skill, workspace instruction, or Knowledge
 * change) that authority or policy refused carries this fact under `_meta`.
 * MCP `_meta` never reaches the model: it survives only into the
 * `agent.toolCall.output` event projection, where the timeline tells the
 * person their change was not saved, whatever the agent then says.
 */
export const LEARNING_REFUSAL_META_KEY = "opengeni/learningRefusal" as const;

export const LEARNING_REFUSAL_DESTINATIONS = ["skill", "instruction", "knowledge"] as const;
/** Where the refused change would have been saved. */
export type LearningRefusalDestination = (typeof LEARNING_REFUSAL_DESTINATIONS)[number];

/**
 * Why it was refused, in terms a person can act on:
 * - `personal_chat`: this chat's Agent learning saves only for its person (a
 *   private chat, a chat using personal memory, or a personal workspace), and
 *   the change targets something shared with the workspace.
 * - `personal_target`: this chat's Agent learning saves for the workspace,
 *   and the change targets a personal Skill.
 * - `learning_off`: Agent learning for this destination is Off for this chat.
 * - `site_agent`: an agent started from a Site page never saves learning.
 * - `not_permitted`: any other definite authority or policy refusal.
 */
export const LEARNING_REFUSAL_REASONS = [
  "personal_chat",
  "personal_target",
  "learning_off",
  "site_agent",
  "not_permitted",
] as const;
export type LearningRefusalReason = (typeof LEARNING_REFUSAL_REASONS)[number];

/** Codes and ids only: never the refused text, a Skill's name, or a server message. */
export type LearningRefusal = {
  destination: LearningRefusalDestination;
  reason: LearningRefusalReason;
  /** The existing Skill the change targeted, when there was one. */
  skillId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** The exact closed fact, or null when the input is not one. */
function exactRefusal(value: unknown): LearningRefusal | null {
  const fact = record(value);
  if (!fact) return null;
  if (Object.keys(fact).some((key) => !["destination", "reason", "skillId"].includes(key)))
    return null;
  if (!oneOf(LEARNING_REFUSAL_DESTINATIONS, fact.destination)) return null;
  if (!oneOf(LEARNING_REFUSAL_REASONS, fact.reason)) return null;
  if (fact.skillId !== undefined && (typeof fact.skillId !== "string" || !UUID.test(fact.skillId)))
    return null;
  return {
    destination: fact.destination,
    reason: fact.reason,
    ...(fact.skillId !== undefined ? { skillId: fact.skillId as string } : {}),
  };
}

/**
 * The tool result with the refusal fact added to its `_meta`; nothing else
 * changes. Only the exact closed shape is attached.
 */
export function withLearningRefusalMeta<T extends object>(result: T, refusal: LearningRefusal): T {
  const fact = exactRefusal(refusal);
  if (!fact) throw new TypeError("Invalid learning refusal");
  const meta = record((result as { _meta?: unknown })._meta);
  return { ...result, _meta: { ...meta, [LEARNING_REFUSAL_META_KEY]: fact } } as T;
}

/**
 * The learning-refusal fact on a tool result or its event projection, when
 * present and valid. Stored events outlive their writer: a reader ignores
 * fields a newer writer added, and reads an unknown newer reason as the
 * generic refusal rather than dropping the fact.
 */
export function learningRefusalFromToolOutput(output: unknown): LearningRefusal | null {
  const fact = record(record(record(output)?._meta)?.[LEARNING_REFUSAL_META_KEY]);
  if (!fact || typeof fact.reason !== "string") return null;
  return exactRefusal({
    destination: fact.destination,
    reason: oneOf(LEARNING_REFUSAL_REASONS, fact.reason) ? fact.reason : "not_permitted",
    ...(fact.skillId !== undefined ? { skillId: fact.skillId } : {}),
  });
}
