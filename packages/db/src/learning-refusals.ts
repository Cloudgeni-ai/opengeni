import type {
  LearningRefusal,
  LearningRefusalDestination,
} from "@opengeni/contracts/learning-refusal";
import { nestedErrorRecords } from "./persistence-errors";

/**
 * A correction the agent can make itself and then retry:
 * - `evidence_not_shared`: cited evidence is personal or not yet published,
 *   so readers of the destination could not see it.
 * - `source_not_shared`: the entry's own source file or document is private
 *   to its owner, belongs to another workspace or is not ready, so readers of
 *   the destination could not open it.
 * - `reference_unavailable`: a referenced entry, revision, source, task note,
 *   confirmation or Skill revision does not exist or is not visible here.
 * - `scope_kept`: the change named a scope other than the one it must keep
 *   (an existing entry's or Skill's own scope, or where this chat learns).
 */
export type LearningSaveCorrection =
  | "evidence_not_shared"
  | "source_not_shared"
  | "reference_unavailable"
  | "scope_kept";

/**
 * What one SQLSTATE 42501 refusal of a durable learning write means:
 * - `correction`: a fixable choice the agent made. The agent is told how to
 *   fix it; the person is shown nothing.
 * - `fence`: the attempt, its host context or what it depended on is no
 *   longer current. The change was not judged; the next attempt or turn
 *   retries it under current authority, so no one is shown a refusal.
 * - `refusal`: a genuine decision a person can act on, Agent learning Off or
 *   not permitted. The agent tells the person and the timeline shows it.
 */
export type LearningRefusalClass =
  | { kind: "correction"; correction: LearningSaveCorrection }
  | { kind: "fence" }
  | { kind: "refusal"; reason: "learning_off" | "not_permitted" };

const correction = (value: LearningSaveCorrection): LearningRefusalClass => ({
  kind: "correction",
  correction: value,
});
const FENCE: LearningRefusalClass = { kind: "fence" };
const LEARNING_OFF: LearningRefusalClass = { kind: "refusal", reason: "learning_off" };
const NOT_PERMITTED: LearningRefusalClass = { kind: "refusal", reason: "not_permitted" };

/**
 * Every 42501 message the Knowledge, workspace instruction and Skill write
 * routines can raise, by its exact text, and what it means. This is the only
 * place that decides it. `learning-refusal-audit-postgres.test.ts` reads every
 * 42501 raise reachable from those routines in the migrated schema and fails
 * on one missing here, so a new message is classified on purpose instead of
 * silently becoming a refusal card. A message not listed (such as a
 * row-level security refusal) is still shown as `not_permitted`: a refusal
 * is never lost silently.
 */
export const LEARNING_REFUSAL_MESSAGES: ReadonlyMap<string, LearningRefusalClass> = new Map([
  // Agent learning is Off where the change would be saved.
  ["Knowledge learning is Off for this task", LEARNING_OFF],
  ["Instruction learning is Off", LEARNING_OFF],
  ["Learning is Off; durable Skill changes are refused", LEARNING_OFF],
  ["governed-learning source is off", LEARNING_OFF],

  // Genuine authority refusals.
  ["Agents cannot approve their own Knowledge", NOT_PERMITTED],
  ["Knowledge review permission required", NOT_PERMITTED],
  ["Knowledge write permission required for this scope", NOT_PERMITTED],
  ["Only people choose where Knowledge works", NOT_PERMITTED],
  ["Personal Knowledge requires the verified initiating owner", NOT_PERMITTED],
  ["Personal learning requires an initiating owner", NOT_PERMITTED],
  ["Instruction review requires workspace administration", NOT_PERMITTED],
  ["Workspace instructions require a workspace agent context", NOT_PERMITTED],
  [
    "Agents cannot review Skills or install workspace plugins from personal learning",
    NOT_PERMITTED,
  ],
  ["Skill outside accepted learning scope", NOT_PERMITTED],
  ["Skill scope is not available to this chat", NOT_PERMITTED],
  ["Skill is outside authorized scope", NOT_PERMITTED],
  ["Skill lifecycle actor is not authorized", NOT_PERMITTED],
  ["Skill confirming human no longer has workspace authority", NOT_PERMITTED],
  ["Permanent removal does not manage organization Skills", NOT_PERMITTED],
  ["Skill has another distribution owner; release it before permanent removal", NOT_PERMITTED],
  ["Removal requires explicit exact deletion approval", NOT_PERMITTED],
  ["governed-learning Task-note authority was revoked", NOT_PERMITTED],
  ["governed-learning document authority was revoked", NOT_PERMITTED],
  // Internal guards no ordinary agent call reaches. If one ever fires it is
  // shown, so the defect is visible rather than retried forever.
  ["Source preparation is limited to its retained original", NOT_PERMITTED],
  ["A removal proposal cannot be activated as Skill content", NOT_PERMITTED],
  ["instruction-policy head deletion requires governed-learning capability", NOT_PERMITTED],
  ["service Knowledge review requires exact governed-learning capability", NOT_PERMITTED],

  // Corrections: cited evidence readers of the destination couldn't see.
  ["Knowledge evidence has not been published", correction("evidence_not_shared")],
  ["Knowledge reference would widen source access", correction("evidence_not_shared")],
  ["Instruction evidence is unavailable to workspace readers", correction("evidence_not_shared")],
  // Corrections: an entry's own source readers of its scope couldn't open.
  ["File source requires its authorized scope", correction("source_not_shared")],
  ["Knowledge source would widen document access", correction("source_not_shared")],
  ["Source file unavailable", correction("source_not_shared")],
  // Corrections: a reference that does not exist or is not visible here.
  ["Knowledge reference unavailable", correction("reference_unavailable")],
  ["Knowledge source unavailable", correction("reference_unavailable")],
  ["Knowledge revision unavailable", correction("reference_unavailable")],
  ["Knowledge unavailable", correction("reference_unavailable")],
  ["Prepared source identity is unavailable", correction("reference_unavailable")],
  ["Task note is expired, archived or outside this task tree", correction("reference_unavailable")],
  [
    "Task-note promotion requires an exact agent and note version",
    correction("reference_unavailable"),
  ],
  ["Exact human confirmation unavailable", correction("reference_unavailable")],
  ["Migrated confirmation content unavailable", correction("reference_unavailable")],
  ["Migrated confirmation evidence changed", correction("reference_unavailable")],
  ["Migrated confirmation evidence unavailable", correction("reference_unavailable")],
  ["No migrated Knowledge confirmation matches this claim", correction("reference_unavailable")],
  ["No imported instruction matches this confirmation", correction("reference_unavailable")],
  ["governed-learning Knowledge claim is unavailable", correction("reference_unavailable")],
  [
    "governed-learning instruction-policy draft is unavailable",
    correction("reference_unavailable"),
  ],
  [
    "governed-learning instruction-policy proposal is unavailable",
    correction("reference_unavailable"),
  ],
  ["governed-learning preference proposal is unavailable", correction("reference_unavailable")],
  ["governed-learning preference revision is unavailable", correction("reference_unavailable")],
  ["governed-learning rollback target is unavailable", correction("reference_unavailable")],
  ["confirmable evaluator receipt is unavailable", correction("reference_unavailable")],
  [
    "exact inactive instruction-policy proposal is unavailable",
    correction("reference_unavailable"),
  ],
  ["exact inactive preference proposal is unavailable", correction("reference_unavailable")],
  ["human confirmation for this proposal is unavailable", correction("reference_unavailable")],
  ["human confirmation requires exact Task-note evidence", correction("reference_unavailable")],
  ["Skill revision unavailable", correction("reference_unavailable")],
  ["Skill confirmation source unavailable", correction("reference_unavailable")],
  ["Skill source is not installed in this workspace", correction("reference_unavailable")],
  ["Removal approval does not match a removal proposal", correction("reference_unavailable")],
  // Corrections: a scope the change must keep.
  ["Knowledge scope is unavailable or immutable", correction("scope_kept")],
  ["Agent Knowledge stays in its accepted scope", correction("scope_kept")],
  ["Skill scope differs from the requested scope", correction("scope_kept")],

  // Fences: a stale, interrupted or re-scoped attempt or host context.
  ["Knowledge attempt is stale", FENCE],
  ["Knowledge attempt is interrupted", FENCE],
  ["Knowledge session attempt is stale", FENCE],
  ["Knowledge turn attempt is stale", FENCE],
  ["Knowledge requires a human or exact agent attempt", FENCE],
  ["Knowledge requires exact workspace authority", FENCE],
  ["Knowledge workspace unavailable", FENCE],
  ["Knowledge human authority unavailable", FENCE],
  ["Knowledge service authority unavailable", FENCE],
  ["Knowledge initiating turn unavailable", FENCE],
  ["Document preparation lease unavailable", FENCE],
  ["Source preparation requires an exact agent attempt", FENCE],
  ["Learning scope changed after acceptance", FENCE],
  ["Learning accepted turn unavailable", FENCE],
  ["Learning session unavailable", FENCE],
  ["Learning scheduled run unavailable", FENCE],
  ["Legacy confirmation requires an exact agent attempt", FENCE],
  ["Legacy instruction confirmation requires exact tenant and agent authority", FENCE],
  ["Instruction changes require exact tenant scope", FENCE],
  ["Skill lifecycle requires exact tenant context", FENCE],
  ["Skill workspace unavailable", FENCE],
  ["Skill write requires exact live attempt", FENCE],
  ["Skill chat confirmation requires verified human response admission", FENCE],
  ["Exact human Skill confirmation unavailable", FENCE],
  ["Skill approval requires a finalized source owner", FENCE],
  ["Skill activation requires a finalized source owner", FENCE],
  ["Skill parent cascade tenant context mismatch", FENCE],
  ["task notes require exact tenant and attempt authority", FENCE],
  ["task notes require the exact current attempt", FENCE],
  ["task notes require the exact current turn", FENCE],
  ["task note root session is unavailable", FENCE],
  ["task note session is unavailable", FENCE],
  ["task note session tree is not visible to this actor", FENCE],
  ["task note workspace is unavailable", FENCE],
  ["personal document authority snapshot is no longer live", FENCE],
  ["personal document resolve initiating human mismatch", FENCE],
  ["personal document resolve scope mismatch", FENCE],
  ["personal document snapshot collection is incomplete", FENCE],
  ["governed-learning activation requires exact tenant authority", FENCE],
  ["governed-learning activation attempt is unavailable", FENCE],
  ["governed-learning activation session is unavailable", FENCE],
  ["governed-learning activation turn is unavailable", FENCE],
  ["governed-learning proposal lineage changed after evaluation", FENCE],
  ["governed-learning workspace is unavailable", FENCE],
  ["workspace kind authority required", FENCE],
]);

/** What a 42501 refusal of a durable learning write means; unlisted ones are shown. */
export function learningRefusalClass(message: string): LearningRefusalClass {
  return LEARNING_REFUSAL_MESSAGES.get(message) ?? NOT_PERMITTED;
}

/** The correction the agent can make itself, or null. */
export function learningSaveCorrection(message: string): LearningSaveCorrection | null {
  const value = learningRefusalClass(message);
  return value.kind === "correction" ? value.correction : null;
}

/** The message of the 42501 raise inside a possibly wrapped driver error. */
export function nestedAuthorityRefusalMessage(error: unknown): string | null {
  for (const current of nestedErrorRecords(error)) {
    if (
      (current.code === "42501" || current.sqlState === "42501") &&
      typeof current.message === "string"
    )
      return current.message;
  }
  return null;
}

/**
 * What a definite authority refusal of a durable learning write means for the
 * person, or null when it is a fence or a correction the agent can make
 * itself rather than a decision to show anyone.
 */
export function classifyLearningRefusal(input: {
  destination: LearningRefusalDestination;
  message: string;
  skillId?: string | undefined;
}): LearningRefusal | null {
  const value = learningRefusalClass(input.message);
  if (value.kind !== "refusal") return null;
  return {
    destination: input.destination,
    reason: value.reason,
    ...(input.skillId ? { skillId: input.skillId } : {}),
  };
}
