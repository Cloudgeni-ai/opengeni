import type { SessionEvent } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner } from "./internal";

export type UseSessionControlOptions = ClientOverride;

export type UseSessionControlResult = {
  /** Interrupt the running turn (the explicit alternative to queueing). */
  interrupt: (reason?: string) => Promise<SessionEvent | null>;
  interrupting: boolean;
  /** Approve a pending `requires_action` approval. */
  approve: (approvalId: string, message?: string) => Promise<SessionEvent | null>;
  /** Reject a pending `requires_action` approval. */
  reject: (approvalId: string, message?: string) => Promise<SessionEvent | null>;
  /** True while an approval decision is in flight. */
  responding: boolean;
  error: Error | null;
  clearError: () => void;
};

/**
 * Session control events: interrupt and approval decisions. Pair with
 * `useSessionEvents` (for `session.requiresAction` payloads carrying the
 * `approvalId`) to render an approval bar.
 */
export function useSessionControl(
  sessionId: string | null | undefined,
  options: UseSessionControlOptions = {},
): UseSessionControlResult {
  const { client, workspaceId } = useOpenGeni(options);
  const interruptMutation = useMutationRunner();
  const approvalMutation = useMutationRunner();

  const interrupt = useCallback(
    async (reason?: string): Promise<SessionEvent | null> => {
      if (!sessionId) {
        return null;
      }
      return await interruptMutation.run(() =>
        client.interrupt(workspaceId, sessionId, reason !== undefined ? { reason } : {}),
      );
    },
    [client, workspaceId, sessionId, interruptMutation.run],
  );

  const decide = useCallback(
    async (
      approvalId: string,
      decision: "approve" | "reject",
      message?: string,
    ): Promise<SessionEvent | null> => {
      if (!sessionId) {
        return null;
      }
      return await approvalMutation.run(() =>
        client.sendApprovalDecision(workspaceId, sessionId, {
          approvalId,
          decision,
          ...(message !== undefined ? { message } : {}),
        }),
      );
    },
    [client, workspaceId, sessionId, approvalMutation.run],
  );

  const approve = useCallback(
    async (approvalId: string, message?: string) => await decide(approvalId, "approve", message),
    [decide],
  );
  const reject = useCallback(
    async (approvalId: string, message?: string) => await decide(approvalId, "reject", message),
    [decide],
  );

  const error = approvalMutation.mutationError ?? interruptMutation.mutationError;
  const clearError = useCallback(() => {
    interruptMutation.clearMutationError();
    approvalMutation.clearMutationError();
  }, [interruptMutation.clearMutationError, approvalMutation.clearMutationError]);

  return {
    interrupt,
    interrupting: interruptMutation.mutating,
    approve,
    reject,
    responding: approvalMutation.mutating,
    error,
    clearError,
  };
}
