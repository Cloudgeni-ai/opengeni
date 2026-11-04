// Agents calling people (docs/design/agent-calls.md): moving a call to its
// outcome and recording it on the session. The ring itself is a native push
// (ring_agent_call_v1); answering opens the chat's voice call.
import {
  SessionAgentCallSettledPayload,
  SessionNotificationPostedPayload,
  type AgentCall,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  AGENT_CALL_ANSWER_GRACE_SECONDS,
  getAgentCall,
  settleAgentCall,
  type AgentCallOutcome,
  type AgentCallRow,
  type AgentCallScope,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";

type Deps = Pick<ApiRouteDeps, "db" | "bus">;

/** The notification key of a call's missed-call notice: one per call. */
export function agentCallNotificationKey(callId: string): string {
  return `call:${callId}`;
}

/**
 * Settle a ringing call and record the outcome on its session: the settled
 * event, and for a missed call a notification the person can call back from.
 * Returns the settled call, or null when it had already settled (someone else
 * won the race) or the transition does not apply yet.
 */
export async function finishAgentCall(
  deps: Deps,
  input: AgentCallScope & {
    callId: string;
    outcome: AgentCallOutcome;
    calleeSubjectId?: string;
    answeredBy?: string;
  },
): Promise<AgentCallRow | null> {
  const call = await settleAgentCall(deps.db, input);
  if (!call) return null;
  const events: Array<{ type: string; payload: unknown }> = [
    {
      type: "session.agentCall.settled",
      payload: SessionAgentCallSettledPayload.parse({
        callId: call.id,
        calleeSubjectId: call.calleeSubjectId,
        reason: call.reason,
        outcome: call.state,
      }),
    },
  ];
  if (call.state === "missed") {
    events.push({
      type: "session.notification.posted",
      payload: SessionNotificationPostedPayload.parse({
        key: agentCallNotificationKey(call.id),
        title: "Missed call",
        ...(call.callerLabel ? { subtitle: call.callerLabel.slice(0, 120) } : {}),
        body: call.reason,
        urgency: "normal",
        replaced: false,
        ...(call.callerSubjectId
          ? {
              recipientSubjectId: call.calleeSubjectId,
              sender: {
                subjectId: call.callerSubjectId,
                label: (call.callerLabel ?? "A teammate").slice(0, 200),
              },
            }
          : {}),
      }),
    });
  }
  await appendAndPublishEvents(
    deps.db,
    deps.bus,
    call.workspaceId,
    call.sessionId,
    events as Parameters<typeof appendAndPublishEvents>[4],
  );
  return call;
}

/**
 * A call as it is now: one that rang out (past the late-answer grace) is
 * settled as missed on the way.
 */
export async function currentAgentCall(
  deps: Deps,
  input: AgentCallScope & { callId: string },
): Promise<AgentCallRow | null> {
  const call = await getAgentCall(deps.db, input);
  if (
    !call ||
    call.state !== "ringing" ||
    Date.parse(call.ringUntil) + AGENT_CALL_ANSWER_GRACE_SECONDS * 1000 > Date.now()
  ) {
    return call;
  }
  return (
    (await finishAgentCall(deps, { ...input, outcome: "missed" })) ??
    (await getAgentCall(deps.db, input))
  );
}

export function agentCallView(call: AgentCallRow, device?: string | null): AgentCall {
  return {
    id: call.id,
    workspaceId: call.workspaceId,
    sessionId: call.sessionId,
    callerLabel: call.callerLabel,
    reason: call.reason,
    state: call.state,
    ringUntil: call.ringUntil,
    createdAt: call.createdAt,
    endedAt: call.endedAt,
    answeredHere: call.state !== "answered" ? false : device ? call.answeredBy === device : null,
  };
}
