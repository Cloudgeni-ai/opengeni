import type { SessionEvent } from "@opengeni/sdk";

export function sessionCodexRealtimeSynchronousLock(
  events: SessionEvent[],
  workspaceId: string,
  sessionId: string,
): boolean {
  let lifecycleSequence = -1;
  let lifecycleActive = false;
  for (const event of events) {
    if (
      event.sequence > lifecycleSequence &&
      (event.type === "session.realtime.started" || event.type === "session.realtime.ended")
    ) {
      lifecycleSequence = event.sequence;
      lifecycleActive = event.type === "session.realtime.started";
    }
  }
  return lifecycleActive || hasStoredCodexRealtimeOwner(workspaceId, sessionId);
}

export function hasStoredCodexRealtimeOwner(workspaceId: string, sessionId: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return (
      sessionStorage.getItem(`opengeni:codex-realtime-owner:${workspaceId}:${sessionId}`) !== null
    );
  } catch {
    return false;
  }
}
