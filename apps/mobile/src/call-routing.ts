import type { NativeOutsideCallContext } from "@opengeni/react-native";

export const DEFAULT_OUTSIDE_CALL_TARGET = "new" as const;
export type OutsideCallTarget = "new" | "latest" | "pinned";
export type PinnedCallSession = { workspaceId: string; sessionId: string; title: string };

export async function resolveOutsideCallTarget(
  context: NativeOutsideCallContext,
  preferences: {
    target: OutsideCallTarget;
    pinned: PinnedCallSession | null;
    opened: string | null;
    unpin(): void;
    forgetOpened(): void;
    /** The error for a named chat that no longer exists (a voice command's, say). */
    missing?(sessionId: string): Error;
  },
): Promise<string> {
  const { requested, workspaceId, sessionExists, latestOrNew, client } = context;
  if (requested) {
    // A request that names the workspace (a voice command, a recent call, a
    // link) is checked first: a deleted chat is an error, never another call.
    if (context.requestedWorkspaceId && !(await sessionExists(requested))) {
      throw preferences.missing?.(requested) ?? new Error("This chat no longer exists.");
    }
    return requested;
  }
  if (preferences.target === "pinned" && preferences.pinned?.workspaceId === workspaceId) {
    if (await sessionExists(preferences.pinned.sessionId)) return preferences.pinned.sessionId;
    preferences.unpin();
  }
  if (preferences.target === "latest") {
    if (preferences.opened) {
      if (await sessionExists(preferences.opened)) return preferences.opened;
      preferences.forgetOpened();
    }
    return latestOrNew();
  }
  return (await client.createSession(workspaceId, { startMode: "realtime" })).id;
}
