/**
 * Budgets and authoring style for durable text an **agent** writes on a user's
 * behalf.
 *
 * A workspace instruction policy is composed verbatim into the prompt of every
 * session in the workspace, for as long as it stays active, so its length is a
 * permanent per-turn cost rather than a one-time one. A preference is cheaper:
 * only its title and description descriptors are prompt-visible, while the full
 * content is retrieved on demand behind the exact attempt's retrieval handle.
 * Knowledge is cheaper still: it is retrieval evidence and never joins the
 * always-composed prefix.
 *
 * These caps deliberately bind only agent-authored writes. The human-facing
 * limits (`WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS`,
 * `PREFERENCE_REGISTRY_CONTENT_MAX_CHARS`) are unchanged: a person editing a
 * charter in Workspace State is making a deliberate, visible choice, and
 * lowering their limit would reject text they already typed. Existing stored
 * revisions are never rewritten; only new agent writes are bounded.
 */

/** One imperative rule, in 1-3 sentences, fits comfortably under this. */
export const AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS = 600;

/** Retrieved on demand rather than always composed, so a little more room. */
export const AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS = 1_200;

export const AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE =
  `A workspace rule is injected into every session prompt. Keep it under ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} ` +
  "characters: one rule, imperative, no numbered procedure. Split unrelated rules into separate entries.";

export const AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE =
  `A workspace preference is durable Company Brain content and its descriptor is injected into every session prompt. Keep it under ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} ` +
  "characters: state the preference plainly, no numbered procedure and no examples. Put procedure in a Document or Skill and reference it instead.";

/**
 * The shape rule the model reads on every tool that authors durable text.
 * Kept as one sentence-per-clause string so tool descriptions stay consistent.
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
