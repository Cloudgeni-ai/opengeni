import { OpenGeniApiError } from "@opengeni/sdk";
import type {
  SessionTenancyBlocker,
  SessionVisibility,
  SessionVisibilityWork,
} from "@opengeni/sdk";

import { userErrorText } from "@/lib/api-error";

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
  sourceEventId?: string;
  visibility: SessionVisibility;
  workspaceSharedAcknowledged: boolean;
  idempotencyKey: string;
};

export type SessionTenancyFailure = {
  kind:
    | "blocker"
    | "active_work"
    | "stopping_work"
    | "epoch_conflict"
    | "idempotency_conflict"
    | "outcome_unknown"
    | "fork_point"
    | "other";
  message: string;
  retainAttempt: boolean;
  reconcile: boolean;
  /** For `active_work`: what a confirmed change would stop. */
  work?: SessionVisibilityWork;
};

const BLOCKER_COPY = {
  nonterminal_turn: "Wait for the current turn to finish.",
  nonterminal_attempt: "Wait for the current run attempt to settle.",
  unsettled_interruption: "Resolve the current interruption before changing access.",
  pending_system_update:
    "A pending agent update uses someone else's access. Wait for it to be delivered first.",
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
  shared_sandbox_group:
    "This session shares its sandbox with other sessions. Fork it into a separate session to make this change.",
} satisfies Record<SessionTenancyBlocker, string>;

export function sessionTenancyBlockerMessage(blocker: unknown): string | null {
  return typeof blocker === "string" && blocker in BLOCKER_COPY
    ? BLOCKER_COPY[blocker as SessionTenancyBlocker]
    : null;
}

export function sessionVisibilityWorkIsEmpty(work: SessionVisibilityWork): boolean {
  return sessionVisibilityWorkSummary(work).length === 0;
}

/** One line per consequence of "make private anyway", in the order they happen. */
export function sessionVisibilityWorkSummary(work: SessionVisibilityWork): string[] {
  const lines: string[] = [];
  if (work.runningTurnCount > 0) lines.push("Stop the response that is in progress");
  if (work.queuedTurnCount > 0) {
    lines.push(
      work.queuedTurnCount === 1
        ? "Cancel 1 queued message"
        : `Cancel ${work.queuedTurnCount} queued messages`,
    );
  }
  if (work.activeGoal) lines.push("Pause the active goal");
  if (work.liveVoice) lines.push("End the live voice conversation");
  if (work.otherPeoplePendingUpdateCount > 0) {
    lines.push(
      work.otherPeoplePendingUpdateCount === 1
        ? "Drop a pending update that uses someone else's access"
        : `Drop ${work.otherPeoplePendingUpdateCount} pending updates that use other people's access`,
    );
  }
  if (work.otherPeopleAccountChoiceCount > 0) {
    lines.push(
      work.otherPeopleAccountChoiceCount === 1
        ? "Stop using another person's account in this session"
        : "Stop using other people's accounts in this session",
    );
  }
  return lines;
}

/** True when confirming stops something running, not only drops other people's access. */
export function sessionVisibilityWorkStopsWork(work: SessionVisibilityWork): boolean {
  return work.runningTurnCount > 0 || work.queuedTurnCount > 0 || work.activeGoal || work.liveVoice;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function visibilityWorkFromDetails(details: unknown): SessionVisibilityWork | null {
  if (!details || typeof details !== "object") return null;
  const value = details as Record<string, unknown>;
  const { runningTurnCount, queuedTurnCount, activeGoal } = value;
  if (
    typeof runningTurnCount !== "number" ||
    typeof queuedTurnCount !== "number" ||
    typeof activeGoal !== "boolean"
  ) {
    return null;
  }
  // An older server reports only the first three fields.
  return {
    runningTurnCount,
    queuedTurnCount,
    activeGoal,
    liveVoice: value.liveVoice === true,
    otherPeoplePendingUpdateCount: count(value.otherPeoplePendingUpdateCount),
    otherPeopleAccountChoiceCount: count(value.otherPeopleAccountChoiceCount),
  };
}

/** A preview from any server release, with fields an older one omits filled in. */
export function normalizeSessionVisibilityWork(work: unknown): SessionVisibilityWork | null {
  return visibilityWorkFromDetails(work);
}

/** The consented stop is still settling; the same request finishes it. */
export function isStoppingSessionWorkError(error: unknown): boolean {
  return error instanceof OpenGeniApiError && error.details?.reason === "stopping_active_work";
}

/**
 * Making a session private hides its conversation, not its sandbox. Files on a
 * shared sandbox or Connected Machine stay as available as the box itself.
 */
export function privateSessionSandboxNote(sandboxBackend: string | null | undefined): string {
  if (sandboxBackend === "none") return "";
  return sandboxBackend === "selfhosted"
    ? " Files on its connected machine stay available to whoever can use that machine."
    : " Files in its sandbox stay available to other sessions that share it.";
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

export function isCurrentSessionTenancyTarget(
  current: SessionTenancyTarget,
  accepted: SessionTenancyTarget,
): boolean {
  return current.workspaceId === accepted.workspaceId && current.sessionId === accepted.sessionId;
}

const FORK_POINT_COPY: Record<string, string> = {
  fork_point_message_unavailable:
    "Only your messages and the agent's replies can be fork points. Choose one of those, or fork the whole session.",
  fork_point_boundary_not_retained:
    "This message is from before the conversation was compacted, so it can't be a fork point. Choose a more recent message, or fork the whole session.",
  fork_point_history_compacted:
    "The conversation up to this message was compacted, so it can't be copied as it was then. Choose a more recent message, or fork the whole session.",
  fork_point_unfinished_tool_exchange:
    "The agent was still waiting for a tool result at this message. Choose a later message, or fork the whole session.",
};

export function classifySessionTenancyFailure(error: unknown): SessionTenancyFailure {
  if (!(error instanceof OpenGeniApiError)) {
    return {
      kind: error instanceof TypeError ? "outcome_unknown" : "other",
      message:
        error instanceof TypeError
          ? "The server outcome is unknown. Opengeni is checking the session before retrying."
          : userErrorText(error),
      retainAttempt: error instanceof TypeError,
      reconcile: error instanceof TypeError,
    };
  }

  if (error.outcomeUnknown) {
    return {
      kind: "outcome_unknown",
      message: "The server outcome is unknown. Opengeni is checking the session before retrying.",
      retainAttempt: true,
      reconcile: true,
    };
  }

  const reason = error.details?.reason;
  if (typeof reason === "string" && reason.startsWith("fork_point_")) {
    return {
      kind: "fork_point",
      message:
        FORK_POINT_COPY[reason] ??
        "This message can't be used as a fork point. Choose a more recent message, or fork the whole session.",
      retainAttempt: false,
      reconcile: false,
    };
  }
  if (reason === "active_work") {
    const work = visibilityWorkFromDetails(error.details);
    return {
      kind: "active_work",
      message: "Work started in this session. Review what will stop, then confirm again.",
      retainAttempt: true,
      reconcile: false,
      ...(work ? { work } : {}),
    };
  }
  if (reason === "stopping_active_work") {
    return {
      kind: "stopping_work",
      message: "The current work is still stopping. Try again in a moment.",
      retainAttempt: true,
      reconcile: false,
    };
  }
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
    message: userErrorText(error),
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
