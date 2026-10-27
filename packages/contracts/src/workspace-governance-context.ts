/**
 * Durable, model-visible workspace governance context.
 *
 * Governance (instruction policies, learning settings, organization profile)
 * can change between turns and differs by who starts a turn. In the system
 * prompt, every such change rewrote text that earlier requests had already sent
 * and invalidated the whole cached history. It is therefore delivered as a
 * history item inserted before the turn that first sees a new value; earlier
 * items stay byte-identical, and the newest item replaces older ones.
 */
export const WORKSPACE_GOVERNANCE_CONTEXT_PREFIX = "<opengeni_workspace_governance>\n";
export const WORKSPACE_GOVERNANCE_CONTEXT_SUFFIX = "\n</opengeni_workspace_governance>";
const GUIDANCE =
  "This is the current workspace governance and replaces earlier workspace governance blocks.\n\n";
/** Recorded when governance that applied earlier no longer does. */
export const WORKSPACE_GOVERNANCE_NONE = "No workspace governance is active.";

export function workspaceGovernanceContextItem(governance: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content:
      WORKSPACE_GOVERNANCE_CONTEXT_PREFIX +
      GUIDANCE +
      governance +
      WORKSPACE_GOVERNANCE_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readWorkspaceGovernanceContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readWorkspaceGovernanceContext(data);
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
  const prefix = WORKSPACE_GOVERNANCE_CONTEXT_PREFIX + GUIDANCE;
  return content?.startsWith(prefix) && content.endsWith(WORKSPACE_GOVERNANCE_CONTEXT_SUFFIX)
    ? content.slice(prefix.length, -WORKSPACE_GOVERNANCE_CONTEXT_SUFFIX.length)
    : null;
}

export function latestWorkspaceGovernanceContext(
  items: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const governance = readWorkspaceGovernanceContext(items[index]!);
    if (governance !== null) return workspaceGovernanceContextItem(governance);
  }
  return undefined;
}
