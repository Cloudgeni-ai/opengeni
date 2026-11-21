/**
 * Durable, model-visible state of the workspace when a session started
 * (OPENGENI_EXPERIMENT_TOOL_EFFICIENCY): Git status, a short top-level
 * listing and the root AGENTS.md, gathered once before the first model
 * request so the model does not spend its first steps looking them up.
 *
 * It is a developer history item inserted before the session's first turn
 * and never rewritten, so later requests keep a byte-identical prefix. It
 * describes one moment and is not refreshed: tool results are current.
 */
export const STARTING_CONTEXT_PREFIX = "<opengeni_starting_context>\n";
export const STARTING_CONTEXT_SUFFIX = "\n</opengeni_starting_context>";
const GUIDANCE =
  "The workspace root as it was when this session started, read before your first step. Files may have changed since.\n\n";

export function startingContextItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: STARTING_CONTEXT_PREFIX + GUIDANCE + text + STARTING_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readStartingContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readStartingContext(data);
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
    !content?.startsWith(STARTING_CONTEXT_PREFIX) ||
    !content.endsWith(STARTING_CONTEXT_SUFFIX) ||
    content.length < STARTING_CONTEXT_PREFIX.length + STARTING_CONTEXT_SUFFIX.length
  )
    return null;
  const body = content.slice(STARTING_CONTEXT_PREFIX.length, -STARTING_CONTEXT_SUFFIX.length);
  return body.startsWith(GUIDANCE) ? body.slice(GUIDANCE.length) : body;
}

/** True when the items already show a starting context. */
export function hasStartingContext(items: readonly unknown[]): boolean {
  return items.some(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      readStartingContext(item as Record<string, unknown>) !== null,
  );
}
