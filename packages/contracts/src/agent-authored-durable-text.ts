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
 *   in the storage contract for compatibility but are not composed.
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
  "A workspace preference is durable Company Brain content that agents retrieve on demand, so its length is " +
  "retrieval cost rather than standing prompt cost: only its short title and description are composed into " +
  `every session prompt. Keep it under ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} characters: state the ` +
  "preference plainly, no numbered procedure and no examples. Put procedure in a Document or Skill and " +
  "reference it instead.";

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
export const AGENT_AUTHORED_DURABLE_TEXT_STYLE =
  "Durable text is prompt cost, not a place to be thorough: write one imperative statement in 1-3 sentences, " +
  "with no numbered steps, no examples, no rationale and no restating of defaults. Prefer several small entries " +
  "over one long one, and keep procedure in a Document or Skill that the rule references instead of inlining it.";

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
