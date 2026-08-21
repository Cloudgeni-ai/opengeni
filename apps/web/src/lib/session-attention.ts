import type { Session } from "@/types";

export type ActiveSessionReadCandidate = Pick<
  Session,
  "id" | "workspaceId" | "unread" | "archived"
>;

/** One foreground-view receipt per exact session event frontier. */
export function sessionReadProjectionKey(sessionId: string, latestEventSequence: number): string {
  return `${sessionId}:${latestEventSequence}`;
}

/**
 * A chat is read only while the exact route is genuinely in the foreground.
 * Merely leaving a session route mounted in a background tab/window must not
 * consume its unread signal.
 */
export function shouldAcknowledgeActiveSession(input: {
  activeSessionId: string | null;
  workspaceId: string;
  session: ActiveSessionReadCandidate | null;
  documentVisible: boolean;
  windowFocused: boolean;
}): boolean {
  const { session } = input;
  return Boolean(
    input.documentVisible &&
    input.windowFocused &&
    session &&
    !session.archived &&
    session.unread &&
    session.workspaceId === input.workspaceId &&
    session.id === input.activeSessionId,
  );
}
