import { OpenGeniApiError } from "@opengeni/sdk";
import type { SessionVisibility } from "@opengeni/sdk";

type SessionTenancyBlocker =
  | "nonterminal_turn"
  | "nonterminal_attempt"
  | "unsettled_interruption"
  | "pending_system_update"
  | "pending_human_input"
  | "pending_tool_receipt"
  | "run_state"
  | "active_goal"
  | "capacity_waiter"
  | "active_realtime"
  | "active_scheduled_task"
  | "workspace_mutation_admission"
  | "retained_process"
  | "active_sandbox_access"
  | "shared_sandbox_group";

export type SessionTenancyTarget = {
  workspaceId: string;
  sessionId: string;
};

export type PendingSessionVisibilityAttempt = SessionTenancyTarget & {
  visibility: SessionVisibility;
  expectedAuthorityEpoch: number;
  idempotencyKey: string;
};

export type PendingSessionForkAttempt = SessionTenancyTarget & {
  idempotencyKey: string;
};

export type SessionTenancyFailure = {
  kind: "blocker" | "epoch_conflict" | "idempotency_conflict" | "outcome_unknown" | "other";
  message: string;
  retainAttempt: boolean;
  reconcile: boolean;
};

const BLOCKER_COPY = {
  nonterminal_turn: "Wait for the current turn to finish.",
  nonterminal_attempt: "Wait for the current run attempt to settle.",
  unsettled_interruption: "Resolve the current interruption before changing access.",
  pending_system_update: "Wait for the pending agent update to be accepted.",
  pending_human_input: "Answer or skip the pending question first.",
  pending_tool_receipt: "Resolve the pending tool request first.",
  run_state: "Wait for the paused run state to settle.",
  active_goal: "Pause or complete the active goal first.",
  capacity_waiter: "Wait for or cancel the capacity hold first.",
  active_realtime: "End the live voice session first.",
  active_scheduled_task: "Pause the scheduled task that targets this session first.",
  workspace_mutation_admission: "Wait for the current workspace file operation to finish.",
  retained_process: "Stop the retained terminal process first.",
  active_sandbox_access: "Close active Files, Terminal, Desktop, and viewer access first.",
  shared_sandbox_group: "This session shares a sandbox. Private sessions need their own sandbox.",
} satisfies Record<SessionTenancyBlocker, string>;

export function sessionTenancyBlockerMessage(blocker: unknown): string | null {
  return typeof blocker === "string" && blocker in BLOCKER_COPY
    ? BLOCKER_COPY[blocker as SessionTenancyBlocker]
    : null;
}

export function prepareSessionVisibilityAttempt(
  current: PendingSessionVisibilityAttempt | null,
  target: SessionTenancyTarget & {
    visibility: SessionVisibility;
    expectedAuthorityEpoch: number;
  },
  createIdempotencyKey: () => string,
): PendingSessionVisibilityAttempt {
  if (
    current?.workspaceId === target.workspaceId &&
    current.sessionId === target.sessionId &&
    current.visibility === target.visibility &&
    current.expectedAuthorityEpoch === target.expectedAuthorityEpoch
  ) {
    return current;
  }
  return { ...target, idempotencyKey: createIdempotencyKey() };
}

export function prepareSessionForkAttempt(
  current: PendingSessionForkAttempt | null,
  target: SessionTenancyTarget,
  createIdempotencyKey: () => string,
): PendingSessionForkAttempt {
  if (current?.workspaceId === target.workspaceId && current.sessionId === target.sessionId) {
    return current;
  }
  return { ...target, idempotencyKey: createIdempotencyKey() };
}

export function isCurrentSessionTenancyTarget(
  current: SessionTenancyTarget,
  accepted: SessionTenancyTarget,
): boolean {
  return current.workspaceId === accepted.workspaceId && current.sessionId === accepted.sessionId;
}

export function classifySessionTenancyFailure(error: unknown): SessionTenancyFailure {
  if (!(error instanceof OpenGeniApiError)) {
    return {
      kind: error instanceof TypeError ? "outcome_unknown" : "other",
      message:
        error instanceof TypeError
          ? "The server outcome is unknown. OpenGeni is checking the session before retrying."
          : error instanceof Error
            ? error.message
            : String(error),
      retainAttempt: error instanceof TypeError,
      reconcile: error instanceof TypeError,
    };
  }

  if (error.outcomeUnknown) {
    return {
      kind: "outcome_unknown",
      message: "The server outcome is unknown. OpenGeni is checking the session before retrying.",
      retainAttempt: true,
      reconcile: true,
    };
  }

  const reason = error.details?.reason;
  if (reason === "not_quiescent") {
    const blocker = sessionTenancyBlockerMessage(error.details?.blocker);
    return {
      kind: "blocker",
      message: blocker ?? "This session still has active work. Let it become idle, then retry.",
      retainAttempt: true,
      reconcile: true,
    };
  }
  if (reason === "authority_epoch") {
    return {
      kind: "epoch_conflict",
      message: "Session access changed in another tab. The latest state has been loaded.",
      retainAttempt: false,
      reconcile: true,
    };
  }
  if (reason === "operation_reuse" || error.code === "idempotency_conflict") {
    return {
      kind: "idempotency_conflict",
      message: "This operation key no longer matches the requested change. Review and try again.",
      retainAttempt: false,
      reconcile: true,
    };
  }
  return {
    kind: "other",
    message: error.message,
    retainAttempt: false,
    reconcile: error.status === 409,
  };
}

export function retryableSessionTenancyReconciliationFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof OpenGeniApiError && error.retryable);
}

export function visibilityAttemptReachedAuthoritativeState(
  attempt: PendingSessionVisibilityAttempt,
  tenancy: { visibility: SessionVisibility; authorityEpoch: number } | undefined,
): boolean {
  return Boolean(
    tenancy &&
    tenancy.visibility === attempt.visibility &&
    tenancy.authorityEpoch > attempt.expectedAuthorityEpoch,
  );
}
