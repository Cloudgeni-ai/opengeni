import type { SessionEvent } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Pending-approvals projection

   `session.requiresAction` events live forever in the durable log, so a
   console that replays the log from sequence 0 must not render every
   historical approval as actionable. `projectPendingApprovals` folds the
   ordered event log into the approvals that are still undecided *now*:

   - `session.requiresAction` replaces the pending set with the payload's
     approvals (the producer always emits the full currently-pending set, so
     re-emission after a worker re-dispatch cannot duplicate cards);
   - `user.approvalDecision` subtracts the decided approval;
   - the owning turn finishing (`turn.completed`/`turn.failed`/
     `turn.cancelled`) clears the set — whatever was pending died with the
     turn. A `turn.cancelled` for a *different* turn (deleting a queued turn
     while the session waits on an approval) leaves the set alone.

   Pure function — same events in, same approvals out — so approve-then-reload
   projects to an empty set instead of a zombie Approve button.
   -------------------------------------------------------------------------- */

export type PendingApproval = {
  /** The id to send back via `user.approvalDecision` (`approvalId`). */
  id: string;
  /** Tool/function name awaiting the decision. */
  name: string;
  arguments?: unknown;
  /** The raw approval entry from the `session.requiresAction` payload. */
  raw?: unknown;
};

/** The approvals carried by one `session.requiresAction` payload. */
export function approvalsFromRequiresAction(payload: unknown): PendingApproval[] {
  const approvals =
    payload && typeof payload === "object"
      ? (payload as { approvals?: unknown }).approvals
      : undefined;
  if (!Array.isArray(approvals)) {
    return [];
  }
  return approvals.map((approval, index) => {
    const raw = (approval && typeof approval === "object" ? approval : {}) as Record<
      string,
      unknown
    >;
    const rawItem =
      raw.rawItem && typeof raw.rawItem === "object"
        ? (raw.rawItem as Record<string, unknown>)
        : {};
    return {
      id: String(raw.id ?? raw.callId ?? rawItem.callId ?? index),
      name: String(raw.name ?? raw.toolName ?? rawItem.name ?? "approval"),
      arguments: raw.arguments ?? rawItem.arguments,
      raw: approval,
    };
  });
}

/** The approvals still awaiting a decision after replaying `events` in order. */
export function projectPendingApprovals(events: SessionEvent[]): PendingApproval[] {
  let pending: PendingApproval[] = [];
  let owningTurnId: string | null = null;
  for (const event of events) {
    switch (event.type) {
      case "session.requiresAction": {
        pending = approvalsFromRequiresAction(event.payload);
        owningTurnId = event.turnId ?? null;
        break;
      }
      case "user.approvalDecision": {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as { approvalId?: unknown })
            : {};
        if (typeof payload.approvalId === "string") {
          pending = pending.filter((approval) => approval.id !== payload.approvalId);
        }
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        // Scope clearing to the turn that raised the approvals when both
        // sides carry a turn id; clear conservatively when either is unknown.
        if (owningTurnId === null || event.turnId == null || event.turnId === owningTurnId) {
          pending = [];
          owningTurnId = null;
        }
        break;
      }
      default:
        break;
    }
  }
  return pending;
}
