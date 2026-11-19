/**
 * Durable, model-visible filesystem layout of the session's active workspace.
 *
 * The layout names the workspace root, which differs between a managed
 * sandbox and each Connected Machine. In the system prompt, moving a session
 * to another machine rewrote text that earlier requests had already sent and
 * invalidated the whole cached history. It is therefore delivered as a history
 * item inserted before the turn that first sees a new layout; earlier items
 * stay byte-identical, and the newest item replaces older ones.
 */
export const WORKSPACE_FILESYSTEM_CONTEXT_PREFIX = "<opengeni_workspace_filesystem>\n";
export const WORKSPACE_FILESYSTEM_CONTEXT_SUFFIX = "\n</opengeni_workspace_filesystem>";
const GUIDANCE =
  "This is the filesystem layout of the active workspace and replaces earlier filesystem layout blocks. " +
  "Commands and file tools start in its root unless a later tool result says the active machine changed.\n\n";

export function workspaceFilesystemContextItem(layout: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content:
      WORKSPACE_FILESYSTEM_CONTEXT_PREFIX + GUIDANCE + layout + WORKSPACE_FILESYSTEM_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readWorkspaceFilesystemContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readWorkspaceFilesystemContext(data);
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
  const prefix = WORKSPACE_FILESYSTEM_CONTEXT_PREFIX + GUIDANCE;
  return content?.startsWith(prefix) && content.endsWith(WORKSPACE_FILESYSTEM_CONTEXT_SUFFIX)
    ? content.slice(prefix.length, -WORKSPACE_FILESYSTEM_CONTEXT_SUFFIX.length)
    : null;
}

export function latestWorkspaceFilesystemContext(
  items: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const layout = readWorkspaceFilesystemContext(items[index]!);
    if (layout !== null) return workspaceFilesystemContextItem(layout);
  }
  return undefined;
}
