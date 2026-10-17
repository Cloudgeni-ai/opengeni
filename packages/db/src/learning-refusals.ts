import type { SkillScope } from "@opengeni/contracts";
import type {
  LearningRefusal,
  LearningRefusalDestination,
  LearningRefusalReason,
} from "@opengeni/contracts/learning-refusal";

/**
 * The authority refusals a person can act on, by the exact message of the
 * routine that raised them (SQLSTATE 42501). Anything else with that state is
 * the generic `not_permitted`, unless it is a transient attempt fence below.
 */
const REFUSAL_REASONS: ReadonlyMap<string, LearningRefusalReason | "skill_scope"> = new Map([
  ["Learning is Off; durable Skill changes are refused", "learning_off"],
  ["Instruction learning is Off", "learning_off"],
  ["Knowledge learning is Off for this task", "learning_off"],
  // An agent whose learning saves only for its person (a private chat, a
  // chat using personal memory), in a shared workspace.
  ["Workspace instructions require a workspace agent context", "personal_chat"],
  [
    "Agents cannot review Skills or install workspace plugins from personal learning",
    "personal_chat",
  ],
  // The direction depends on the Skill: a shared Skill from a personal-learning
  // chat, or a personal Skill from a workspace-learning chat.
  ["Skill outside accepted learning scope", "skill_scope"],
]);

/**
 * Fences that refuse a stale, interrupted, or re-scoped attempt. The change
 * was not judged: the next attempt or turn retries it under current authority,
 * so these are not a refusal to show anyone.
 */
const TRANSIENT_FENCES = [
  /\bstale\b/iu,
  /\binterrupted\b/iu,
  /exact live attempt/iu,
  /exact tenant/iu,
  /changed after acceptance/iu,
  /requires a human or exact agent attempt/iu,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

/** The message of the 42501 raise inside a possibly wrapped driver error. */
export function nestedAuthorityRefusalMessage(error: unknown): string | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    if (
      (current.code === "42501" || current.sqlState === "42501") &&
      typeof current.message === "string"
    )
      return current.message;
    for (const key of ["cause", "original", "driverError", "error"] as const) {
      if (current[key] !== undefined) queue.push(current[key]);
    }
  }
  return null;
}

/**
 * What a definite authority refusal of a durable learning write means for the
 * person, or null when the refusal is a transient fence rather than a policy
 * decision. `skillScope` is the scope of the existing Skill the change
 * targeted, when known.
 */
export function classifyLearningRefusal(input: {
  destination: LearningRefusalDestination;
  message: string;
  skillId?: string | undefined;
  skillScope?: SkillScope | null | undefined;
}): LearningRefusal | null {
  if (TRANSIENT_FENCES.some((fence) => fence.test(input.message))) return null;
  const known = REFUSAL_REASONS.get(input.message);
  const reason: LearningRefusalReason =
    known === "skill_scope"
      ? input.skillScope === "user"
        ? "personal_target"
        : input.skillScope === "workspace" || input.skillScope === "organization"
          ? "personal_chat"
          : "not_permitted"
      : (known ?? "not_permitted");
  return {
    destination: input.destination,
    reason,
    ...(input.skillId ? { skillId: input.skillId } : {}),
  };
}
