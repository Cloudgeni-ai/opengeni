import { z } from "zod";

/** Conversational context only. Never an authority or an implicit dispatch destination. */
export const SessionTargetContext = z
  .object({
    version: z.number().int().nonnegative(),
    sessionId: z.string().uuid().nullable(),
    operationId: z.string().uuid().nullable(),
  })
  .strict();
export type SessionTargetContext = z.infer<typeof SessionTargetContext>;

export const SetSessionTargetRequest = z
  .object({
    sessionId: z.string().uuid().nullable(),
    expectedVersion: z.number().int().nonnegative(),
    operationId: z.string().uuid(),
  })
  .strict();
export type SetSessionTargetRequest = z.infer<typeof SetSessionTargetRequest>;

export const SESSION_TARGET_CONTEXT_KEY = "conversationTargetV1";

export function sessionTargetContext(metadata: Record<string, unknown>): SessionTargetContext {
  return SessionTargetContext.parse(
    metadata[SESSION_TARGET_CONTEXT_KEY] ?? {
      version: 0,
      sessionId: null,
      operationId: null,
    },
  );
}

/** CAS plus exact retry replay; an old retry cannot restore a subsequently cleared target. */
export function nextSessionTargetContext(
  current: SessionTargetContext,
  request: SetSessionTargetRequest,
): SessionTargetContext {
  SetSessionTargetRequest.parse(request);
  if (current.operationId === request.operationId) {
    if (current.sessionId !== request.sessionId || current.version !== request.expectedVersion + 1)
      throw new Error("Session target operation was reused with different input");
    return current;
  }
  if (current.version !== request.expectedVersion)
    throw new Error("Session target changed; read it again");
  return {
    version: current.version + 1,
    sessionId: request.sessionId,
    operationId: request.operationId,
  };
}
