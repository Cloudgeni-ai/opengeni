/**
 * "Waiting on <person>" for a chat's status line, from `session.waitingOn`:
 * the agent's own `set_waiting_on`, or an open question or approval, which
 * waits on the person the turn works for. Display only.
 */
import type { SessionWaitingOn } from "@opengeni/sdk";

import { useOptionalAppContext } from "../app-context";
import { useResolvedCreator } from "./creator-labels";

/** The status line for a wait, given the viewer and a member name when known. */
export function formatWaitingOn(
  waitingOn: SessionWaitingOn,
  viewerSubjectId: string | null,
  memberName: string | null,
): string {
  if (waitingOn.subjectId && waitingOn.subjectId === viewerSubjectId) return "Waiting on you";
  const name = waitingOn.person?.trim() || memberName?.trim() || null;
  if (name) return `Waiting on ${name}`;
  // An open question with no known person keeps the long-standing wording.
  return waitingOn.source === "input" && !waitingOn.subjectId ? "Waiting on you" : "Waiting";
}

/** {@link formatWaitingOn} for the signed-in viewer, naming members once they load. */
export function useWaitingOnLabel(
  workspaceId: string,
  waitingOn: SessionWaitingOn | null | undefined,
): string | null {
  const context = useOptionalAppContext();
  const viewerSubjectId = waitingOn ? (context?.accessContext?.subjectId ?? null) : null;
  const needsName =
    waitingOn &&
    !waitingOn.person &&
    waitingOn.subjectId &&
    waitingOn.subjectId !== viewerSubjectId;
  const resolved = useResolvedCreator(
    workspaceId,
    needsName ? { kind: "subject", subjectId: waitingOn.subjectId! } : null,
  );
  if (!waitingOn) return null;
  return formatWaitingOn(waitingOn, viewerSubjectId, resolved?.label ?? null);
}
