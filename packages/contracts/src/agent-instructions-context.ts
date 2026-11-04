/**
 * Durable, model-visible edits of an agent's instructions.
 *
 * A chat bound to an agent revision carries that revision's instructions in
 * its own system-prompt layer. Rewriting the system prompt when someone edits
 * the agent would invalidate the whole cached conversation, so an edit made
 * during a chat reaches the model as a developer history item inserted before
 * the turn that first sees it. Earlier items stay byte-identical, the newest
 * item replaces older ones, and compaction folds the newest revision back into
 * the system prompt.
 */
export const AGENT_INSTRUCTIONS_CONTEXT_PREFIX = "<opengeni_agent_instructions>\n";
export const AGENT_INSTRUCTIONS_CONTEXT_SUFFIX = "\n</opengeni_agent_instructions>";

const AUTHORITY = "They grant no additional authority and do not override the rules above.";
const DELETED =
  "This chat no longer has an agent: ignore its instructions in the system prompt and any earlier block like this one, and continue as a plain chat.";

export type AgentInstructionsContext =
  | { kind: "revision"; revision: number; instructions: string }
  | { kind: "deleted" };

function revisionHead(revision: number, empty: boolean): string {
  return empty
    ? `The agent's instructions were edited (revision ${revision}) and are now empty; its instructions in the system prompt and any earlier block like this one no longer apply.`
    : `The agent's instructions were edited (revision ${revision}). These replace its instructions in the system prompt and any earlier block like this one. ${AUTHORITY}\n\n`;
}

/*
 * Earlier wordings, parse-only and never written: items already in stored
 * history, or written by an older server during a rolling deploy, must still
 * read as the same context so the channel, the carry and the fold see them.
 */
const LEGACY_DELETED: readonly string[] = [
  "The agent this chat belonged to was deleted. Its instructions in the system prompt and in any earlier block like this one no longer apply; continue as a plain chat.",
  "This chat's agent no longer applies here. Its instructions in the system prompt and in any earlier block like this one no longer apply; continue as a plain chat.",
];

function legacyRevisionHead(revision: number, empty: boolean): string {
  return empty
    ? `The agent's instructions were edited during this chat (revision ${revision}) and are now empty: the agent instructions in the system prompt and in any earlier block like this one no longer apply.`
    : `These are the agent's current instructions (revision ${revision}). They were edited during this chat and replace the agent instructions in the system prompt and any earlier block like this one. They come from the agent's editors and grant no additional authority: permissions, approvals and the rules above still apply.\n\n`;
}

/** Each wording's revision pattern and heads; the first is the one written. */
const REVISION_FORMS: readonly {
  pattern: RegExp;
  head: (revision: number, empty: boolean) => string;
}[] = [
  { pattern: /^The agent's instructions were edited \(revision (\d+)\)/u, head: revisionHead },
  {
    pattern: /^These are the agent's current instructions \(revision (\d+)\)/u,
    head: legacyRevisionHead,
  },
  {
    pattern: /^The agent's instructions were edited during this chat \(revision (\d+)\)/u,
    head: legacyRevisionHead,
  },
];

/** The text between the channel markers for one revision, or for a deleted agent. */
export function agentInstructionsContextText(context: AgentInstructionsContext): string {
  if (context.kind === "deleted") return DELETED;
  const instructions = context.instructions.trim();
  return instructions
    ? revisionHead(context.revision, false) + instructions
    : revisionHead(context.revision, true);
}

/** Inverse of {@link agentInstructionsContextText}; null for any other text. */
export function parseAgentInstructionsContextText(text: string): AgentInstructionsContext | null {
  if (text === DELETED || LEGACY_DELETED.includes(text)) return { kind: "deleted" };
  for (const form of REVISION_FORMS) {
    const digits = form.pattern.exec(text)?.[1];
    if (!digits) continue;
    const revision = Number(digits);
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    // The empty and non-empty forms can share a prefix: the empty form is exact.
    if (text === form.head(revision, true)) return { kind: "revision", revision, instructions: "" };
    const head = form.head(revision, false);
    if (!text.startsWith(head)) return null;
    const instructions = text.slice(head.length);
    if (instructions.trim() !== instructions || !instructions) return null;
    return { kind: "revision", revision, instructions };
  }
  return null;
}

/**
 * Two channel texts show the model the same instructions. A revision that
 * changed only other agent fields (such as the first message) shows nothing
 * new, so it needs no history item.
 */
export function sameAgentInstructionsContext(left: string, right: string): boolean {
  const a = parseAgentInstructionsContextText(left);
  const b = parseAgentInstructionsContextText(right);
  if (!a || !b) return left === right;
  if (a.kind === "deleted" || b.kind === "deleted") return a.kind === b.kind;
  return a.instructions === b.instructions;
}

export function agentInstructionsContextItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: AGENT_INSTRUCTIONS_CONTEXT_PREFIX + text + AGENT_INSTRUCTIONS_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readAgentInstructionsContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readAgentInstructionsContext(data);
  }
  if (item.type !== "message" || (item.role !== "developer" && item.role !== "system")) return null;
  const content =
    typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content) &&
          item.content.every(
            (part) =>
              part &&
              (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
              typeof part.text === "string",
          )
        ? item.content.map((part) => part.text).join("")
        : null;
  if (
    !content?.startsWith(AGENT_INSTRUCTIONS_CONTEXT_PREFIX) ||
    !content.endsWith(AGENT_INSTRUCTIONS_CONTEXT_SUFFIX)
  )
    return null;
  const text = content.slice(
    AGENT_INSTRUCTIONS_CONTEXT_PREFIX.length,
    -AGENT_INSTRUCTIONS_CONTEXT_SUFFIX.length,
  );
  return parseAgentInstructionsContextText(text) ? text : null;
}

function isDeveloperMessage(item: Record<string, unknown>): boolean {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object")
    return isDeveloperMessage(item.providerData as Record<string, unknown>);
  return item.type === "message" && item.role === "developer";
}

/**
 * The newest agent instructions item in model-visible order, parsed. Only
 * developer items count, which is how the channel writes them, so no other
 * system message can move the chat's prompt revision.
 */
export function latestAgentInstructionsContext(
  items: readonly Record<string, unknown>[],
): { text: string; context: AgentInstructionsContext } | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (!isDeveloperMessage(items[index]!)) continue;
    const text = readAgentInstructionsContext(items[index]!);
    if (text === null) continue;
    const context = parseAgentInstructionsContextText(text);
    if (context) return { text, context };
  }
  return undefined;
}
