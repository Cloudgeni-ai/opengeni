export type RealtimeVoiceTargetMode = "session" | "workspace-main";

export function sessionIdFromWorkspacePath(pathname: string): string | null {
  const match = /\/sessions\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

/** Resolve only the explicitly selected target. There is deliberately no fallback. */
export function resolveRealtimeVoiceTarget(
  mode: RealtimeVoiceTargetMode,
  selectedSessionId: string | null,
  workspaceMainSessionId: string | null,
): string | null {
  return mode === "session" ? selectedSessionId : workspaceMainSessionId;
}
