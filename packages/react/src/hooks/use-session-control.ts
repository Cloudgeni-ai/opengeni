import type { SessionControlResponse, SessionEvent } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner } from "./internal";

export type UseSessionControlOptions = ClientOverride;

export type UseSessionControlResult = {
  pause: (reason?: string) => Promise<SessionControlResponse | null>;
  resume: (reason?: string) => Promise<SessionControlResponse | null>;
  controlling: boolean;
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
 * Session pause/resume and approval decisions. Pair with
 * `useSessionEvents` (for `session.requiresAction` payloads carrying the
 * `approvalId`) to render an approval bar.
 */
export function useSessionControl(
  sessionId: string | null | undefined,
  options: UseSessionControlOptions = {},
): UseSessionControlResult {
  const { client, workspaceId } = useOpenGeni(options);
  const {
    run: runControl,
    mutating: controlling,
    mutationError: controlError,
    clearMutationError: clearControlError,
  } = useMutationRunner();
  const {
    run: runApproval,
    mutating: responding,
    mutationError: approvalError,
    clearMutationError: clearApprovalError,
  } = useMutationRunner();

  const pause = useCallback(
    async (reason?: string): Promise<SessionControlResponse | null> => {
      if (!sessionId) {
        return null;
      }
      return await runControl(() =>
        client.pauseSession(workspaceId, sessionId, reason !== undefined ? { reason } : {}),
      );
    },
    [client, workspaceId, sessionId, runControl],
  );

  const resume = useCallback(
    async (reason?: string): Promise<SessionControlResponse | null> => {
      if (!sessionId) return null;
      return await runControl(() =>
        client.resumeSession(workspaceId, sessionId, reason !== undefined ? { reason } : {}),
      );
    },
    [client, workspaceId, sessionId, runControl],
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
      return await runApproval(() =>
        client.sendApprovalDecision(workspaceId, sessionId, {
          approvalId,
          decision,
          ...(message !== undefined ? { message } : {}),
        }),
      );
    },
    [client, workspaceId, sessionId, runApproval],
  );

  const approve = useCallback(
    async (approvalId: string, message?: string) => await decide(approvalId, "approve", message),
    [decide],
  );
  const reject = useCallback(
    async (approvalId: string, message?: string) => await decide(approvalId, "reject", message),
    [decide],
  );

  const error = approvalError ?? controlError;
  const clearError = useCallback(() => {
    clearControlError();
    clearApprovalError();
  }, [clearControlError, clearApprovalError]);

  return {
    pause,
    resume,
    controlling,
    approve,
    reject,
    responding,
    error,
    clearError,
  };
}
