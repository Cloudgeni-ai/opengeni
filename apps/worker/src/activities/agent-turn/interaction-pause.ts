import { RequestHumanInteractionToolInput } from "@opengeni/contracts";
import { listRecordedInteractionToolCallIds, type Database } from "@opengeni/db";
import {
  interactionRequestNeedingCurrentTarget,
  type InteractionRequestTargetReader,
  type InteractionRequestTargetReading,
} from "@opengeni/runtime";
import {
  stableInteractionInterventionId,
  stableInteractionInterventionOperationId,
} from "./admission";

/** An interaction_request_human call a pause records (or refuses). */
export type InteractionPauseCall = {
  toolCallId: string;
  input: RequestHumanInteractionToolInput;
};

/** The request a requires_action settlement records for one call. */
export type InteractionPauseRequest = InteractionPauseCall & {
  id: string;
  operationId: string;
  currentTarget?: InteractionRequestTargetReading;
};

export const INTERACTION_TARGET_UNREADABLE_HERE = "the target's current state cannot be read here";

/**
 * Build the interaction requests a pause records. A request without an auth
 * run carries its target as it is now, read with the attempt's own authority,
 * so the settlement can fill the generations it left out and check the ones
 * it supplied. Used by the first pause and by every re-freeze.
 */
export async function interactionInterventionRequestsForPause(input: {
  sessionId: string;
  turnId: string;
  calls: readonly InteractionPauseCall[];
  readTarget: InteractionRequestTargetReader | null;
}): Promise<InteractionPauseRequest[]> {
  return await Promise.all(
    input.calls.map(async (call) => {
      const unread = interactionRequestNeedingCurrentTarget(call.input);
      return {
        id: stableInteractionInterventionId(input.sessionId, input.turnId, call.toolCallId),
        operationId: stableInteractionInterventionOperationId(
          input.sessionId,
          input.turnId,
          call.toolCallId,
        ),
        toolCallId: call.toolCallId,
        input: call.input,
        ...(unread
          ? {
              currentTarget: input.readTarget
                ? await input.readTarget(unread)
                : INTERACTION_TARGET_UNREADABLE_HERE,
            }
          : {}),
      };
    }),
  );
}

/** The arguments of a stored interaction_request_human call item. */
export function interactionPauseCallFromItem(
  callId: string,
  callItem: Record<string, unknown>,
): InteractionPauseCall {
  const raw = callItem.arguments;
  return {
    toolCallId: callId,
    input: RequestHumanInteractionToolInput.parse(
      typeof raw === "string" ? JSON.parse(raw) : (raw ?? {}),
    ),
  };
}

/**
 * The request calls of this pause that now hold an intervention. A refused
 * call holds none and is not counted as opened.
 */
export async function recordedInteractionRequestCalls(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    calls: readonly InteractionPauseCall[];
  },
): Promise<InteractionPauseCall[]> {
  const requests = input.calls.filter((call) => call.input.operation === "request");
  const recorded = await listRecordedInteractionToolCallIds(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallIds: requests.map((call) => call.toolCallId),
  });
  return requests.filter((call) => recorded.has(call.toolCallId));
}
