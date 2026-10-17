import type {
  LearningRefusal,
  LearningRefusalDestination,
  LearningRefusalReason,
} from "@opengeni/contracts/learning-refusal";

/**
 * Refusals because Agent learning is Off, by the exact message of the routine
 * that raised them (SQLSTATE 42501). Anything else with that state is the
 * generic `not_permitted`, unless it is a transient attempt fence or a
 * correction the agent can make itself (below). Unknown messages are reported
 * to the person: a refusal must never be lost silently.
 */
const LEARNING_OFF = new Set([
  "Learning is Off; durable Skill changes are refused",
  "Instruction learning is Off",
  "Knowledge learning is Off for this task",
]);

/**
 * Refusals the agent can correct and retry itself, by exact message. They are
 * not a refusal to show the person:
 * - `evidence_not_shared`: cited evidence or a source is personal or not yet
 *   published, so readers of the destination could not see it.
 * - `reference_unavailable`: a referenced entry, revision, source or Skill
 *   revision does not exist or is not visible here.
 * - `skill_scope_kept`: an edit named a scope other than the Skill's own.
 */
export type LearningSaveCorrection =
  | "evidence_not_shared"
  | "reference_unavailable"
  | "skill_scope_kept";

const CORRECTIONS: ReadonlyMap<string, LearningSaveCorrection> = new Map([
  ["Instruction evidence is unavailable to workspace readers", "evidence_not_shared"],
  ["Knowledge evidence has not been published", "evidence_not_shared"],
  ["Knowledge reference would widen source access", "evidence_not_shared"],
  ["Knowledge source would widen document access", "evidence_not_shared"],
  ["Knowledge reference unavailable", "reference_unavailable"],
  ["Knowledge source unavailable", "reference_unavailable"],
  ["Knowledge revision unavailable", "reference_unavailable"],
  ["Skill revision unavailable", "reference_unavailable"],
  ["Skill scope differs from the requested scope", "skill_scope_kept"],
]);

/** The correction the agent can make itself, or null. */
export function learningSaveCorrection(message: string): LearningSaveCorrection | null {
  return CORRECTIONS.get(message) ?? null;
}

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
 * person, or null when it is a transient fence or a correction the agent can
 * make itself rather than a policy decision.
 */
export function classifyLearningRefusal(input: {
  destination: LearningRefusalDestination;
  message: string;
  skillId?: string | undefined;
}): LearningRefusal | null {
  if (TRANSIENT_FENCES.some((fence) => fence.test(input.message))) return null;
  if (CORRECTIONS.has(input.message)) return null;
  const reason: LearningRefusalReason = LEARNING_OFF.has(input.message)
    ? "learning_off"
    : "not_permitted";
  return {
    destination: input.destination,
    reason,
    ...(input.skillId ? { skillId: input.skillId } : {}),
  };
}
