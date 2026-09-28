/**
 * Budgets and authoring style for durable text an **agent** writes on a user's
 * behalf.
 *
 * The budget follows the cost, and the cost differs per destination:
 *
 * - A workspace instruction policy is composed verbatim into the prompt of
 *   every session it applies to, for as long as it stays active. A global
 *   charter or global policy applies to every session in the workspace; a role
 *   policy applies to every session bound to that role. At most three entries
 *   compose at once (charter, global policy, matching role policy), so the
 *   standing ceiling this budget implies is three times the per-entry cap.
 * - A preference is cheaper and in a different way: only its short title and
 *   description descriptors are prompt-composed, while the full content is
 *   retrieved on demand behind the exact attempt's retrieval handle. Its length
 *   is therefore retrieval cost, not standing prompt cost, which is why it gets
 *   more room rather than less.
 * - Organization identity and mission are always-on context for root sessions
 *   across the whole organization. Historical company-profile list fields stay
 *   in the storage contract for compatibility; nonempty values on an already-
 *   active historical revision remain composed with an explicit compatibility
 *   label until an organization owner replaces the profile.
 * - Knowledge is retrieval evidence and never joins the always-composed prefix.
 *
 * These caps deliberately bind only agent-authored writes. The human-facing
 * limits (`WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS`,
 * `PREFERENCE_REGISTRY_CONTENT_MAX_CHARS`, `COMPANY_PROFILE_SCALAR_MAX_CHARS`,
 * `COMPANY_PROFILE_ENTRY_MAX_CHARS`, `COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES`)
 * are unchanged: a person editing in the UI is making a deliberate, visible
 * choice, and lowering their limit would reject text they already typed.
 * Existing stored revisions are never rewritten; only new agent writes are
 * bounded.
 */

/** One imperative rule, in 1-3 sentences, fits comfortably under this. */
export const AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS = 600;

/** Retrieved on demand rather than always composed, so a little more room. */
export const AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS = 1_200;

/** `identity` and `mission`: a couple of sentences, not a positioning document. */
export const AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS = 400;

/** Legacy company-profile list entry bound; retained for stored-revision compatibility. */
export const AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS = 200;

/** Whole canonical compatibility profile; current agent tools submit only identity and mission. */
export const AGENT_AUTHORED_COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES = 4_096;

export const AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE =
  "A workspace rule is composed verbatim into the prompt of every session it applies to (every session " +
  "for a global charter or policy, every session bound to the role for a role policy), for as long as it " +
  `stays active. Keep it under ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters: one rule, ` +
  "imperative, no numbered procedure. Split unrelated rules into separate entries.";

export const AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE =
  "A Skill is durable Agent Knowledge that agents retrieve on demand, so its length is " +
  "retrieval cost rather than standing prompt cost: only its short title and description are composed into " +
  `every session prompt. Keep it under ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} characters: state the ` +
  "trigger and outcome plainly, include only the necessary procedure, checks, and exceptions, and remove " +
  "background, repeated guidance, and decorative examples.";

export const AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE =
  "Organization identity and mission are mandatory prompt context in every root session across the " +
  `organization. Keep each under ${AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS} characters: one concise ` +
  "descriptive statement, no products, customers, goals, constraints, procedure, or marketing copy. Those " +
  "details belong in organization Documents and are retrieved as evidence when relevant.";

/**
 * Lane-agnostic guidance for the one `remember` content field, whose schema
 * bound has to admit the widest lane. Without it an over-long rule would be
 * refused with a generic "expected length <= 4000" that points at the wrong
 * number entirely.
 */
export const AGENT_AUTHORED_REMEMBER_CONTENT_TOO_LONG_MESSAGE =
  "Remembered content is bounded by where it lands: a mandatory workspace rule at most " +
  `${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters because it is composed into every ` +
  `session prompt it applies to, a preference at most ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS}, a ` +
  "Knowledge fact at most 4000. Write one imperative statement in 1-3 sentences, split unrelated entries, and " +
  "keep procedure in a Document or Skill that the entry references.";

/**
 * The shape rule the model reads on every tool that authors a durable *rule or
 * preference*. Deliberately not reused for the company profile, which is a
 * descriptive profile rather than an instruction and needs its own wording.
 */
export const AGENT_AUTHORED_INSTRUCTION_POLICY_STYLE =
  "Write the shortest complete imperative rule in 1-3 sentences, with no numbered procedure, examples, " +
  "rationale, or restated defaults. Split unrelated rules, and move conditional procedure into a Skill.";

/** The sizing rule the model reads on every tool that writes a Skill. */
export const AGENT_AUTHORED_SKILL_STYLE =
  "Size the Skill to the request: a stated preference or habit is two or three plain sentences in SKILL.md; " +
  "a procedure keeps only its trigger, steps, checks, and important failure handling, with long references, " +
  "schemas, or scripts in supporting files. Skip background, restated defaults, and lists of things not to do. " +
  "When editing, change only what the request is about; do not expand other sections.";

/**
 * Every Skill description is composed into every session's prompt index, so an
 * agent-written description stays one short sentence. Bodies are not capped:
 * they are read on demand, and legitimate procedures run to several thousand
 * characters.
 */
export const AGENT_AUTHORED_SKILL_DESCRIPTION_MAX_CHARS = 300;

export const AGENT_AUTHORED_SKILL_DESCRIPTION_TOO_LONG_MESSAGE =
  `Skill descriptions are at most ${AGENT_AUTHORED_SKILL_DESCRIPTION_MAX_CHARS} characters because every ` +
  "description is in every session's prompt index. Shorten it to one sentence saying when to use the Skill.";

/**
 * Refuse an agent-written Skill description over the cap. A description the
 * write leaves exactly as it was in its base revision is not agent-written and
 * passes, so an edit elsewhere never forces an unrelated description rewrite.
 */
export function assertAgentAuthoredSkillDescription(input: {
  description: string;
  baseDescription?: string | null;
}): void {
  if (input.description.length <= AGENT_AUTHORED_SKILL_DESCRIPTION_MAX_CHARS) return;
  if (input.baseDescription != null && input.baseDescription === input.description) return;
  throw new Error(AGENT_AUTHORED_SKILL_DESCRIPTION_TOO_LONG_MESSAGE);
}

/**
 * Actionable over-budget message including the text the caller actually sent,
 * so the model can see how far over it is instead of guessing.
 */
export function agentAuthoredDurableTextTooLongMessage(input: {
  kind: "instruction_policy" | "preference";
  actualChars: number;
}): string {
  const subject = input.kind === "instruction_policy" ? "This rule is" : "This preference is";
  const limit =
    input.kind === "instruction_policy"
      ? AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE
      : AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE;
  return `${subject} ${input.actualChars} characters. ${limit}`;
}
