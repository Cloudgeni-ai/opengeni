import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { approvalsFromRequiresAction, projectPendingApprovals } from "../src/approvals";

let sequence = 0;

function event(
  type: string,
  payload: unknown,
  options: { turnId?: string | null } = {},
): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  };
}

function reset(): void {
  sequence = 0;
}

const requiresAction = (approvals: unknown[], turnId = "turn-1") =>
  event("session.requiresAction", { approvals }, { turnId });
const decision = (approvalId: string, decisionType: "approve" | "reject" = "approve") =>
  event("user.approvalDecision", { approvalId, decision: decisionType }, { turnId: null });

describe("approvalsFromRequiresAction", () => {
  test("maps id/name/arguments and falls back to callId, rawItem.callId, then index", () => {
    const approvals = approvalsFromRequiresAction({
      approvals: [
        { id: "appr-1", name: "run_command", arguments: { cmd: "rm -rf /tmp/x" } },
        { callId: "call-2", name: "push_branch" },
        { rawItem: { callId: "raw-3" } },
        {},
      ],
    });
    expect(approvals.map((approval) => approval.id)).toEqual(["appr-1", "call-2", "raw-3", "3"]);
    expect(approvals[0]).toMatchObject({
      name: "run_command",
      arguments: { cmd: "rm -rf /tmp/x" },
    });
    expect(approvals[3]!.name).toBe("approval");
  });

  test("normalizes the serialized OpenAI Agents tool-approval shape", () => {
    const approvals = approvalsFromRequiresAction({
      approvals: [
        {
          type: "tool_approval_item",
          rawItem: {
            type: "function_call",
            callId: "call-123",
            name: "delete_everything",
            arguments: '{"scope":"workspace"}',
          },
          agent: { name: "reviewer" },
          toolName: "delete_everything",
        },
      ],
    });

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      id: "call-123",
      name: "delete_everything",
      arguments: '{"scope":"workspace"}',
    });
  });

  test("tolerates malformed payloads", () => {
    expect(approvalsFromRequiresAction(null)).toEqual([]);
    expect(approvalsFromRequiresAction("nope")).toEqual([]);
    expect(approvalsFromRequiresAction({ approvals: "nope" })).toEqual([]);
  });
});

describe("projectPendingApprovals", () => {
  // The core regression: the durable log replays every historical approval
  // on page load; a decided approval must never come back actionable.
  test("approve-then-reload projects to no pending approvals", () => {
    reset();
    const log = [
      event("user.message", { text: "deploy" }),
      requiresAction([{ id: "appr-1", name: "run_command" }]),
      decision("appr-1"),
      event("turn.completed", { output: "done" }),
    ];
    expect(projectPendingApprovals(log)).toEqual([]);
  });

  test("with two approvals, deciding one leaves exactly the other pending", () => {
    reset();
    const log = [
      requiresAction([
        { id: "appr-1", name: "run_command" },
        { id: "appr-2", name: "push_branch" },
      ]),
      decision("appr-1", "reject"),
    ];
    expect(projectPendingApprovals(log).map((approval) => approval.id)).toEqual(["appr-2"]);
  });

  test("a second approval pause later in the session is the only one pending", () => {
    reset();
    const log = [
      requiresAction([{ id: "appr-1", name: "run_command" }]),
      decision("appr-1"),
      event("turn.completed", { output: "ok" }),
      requiresAction([{ id: "appr-2", name: "delete_database" }], "turn-2"),
    ];
    expect(projectPendingApprovals(log).map((approval) => approval.id)).toEqual(["appr-2"]);
  });

  test("worker re-dispatch re-emitting requiresAction does not duplicate cards", () => {
    reset();
    const pending = [{ id: "appr-1", name: "run_command" }];
    const log = [
      requiresAction(pending),
      event("turn.preempted", { reason: "worker restart" }),
      requiresAction(pending),
    ];
    expect(projectPendingApprovals(log).map((approval) => approval.id)).toEqual(["appr-1"]);
  });

  test("the owning turn failing or being cancelled clears its approvals", () => {
    reset();
    expect(
      projectPendingApprovals([
        requiresAction([{ id: "appr-1", name: "run_command" }]),
        event("turn.failed", { error: "boom" }),
      ]),
    ).toEqual([]);
    expect(
      projectPendingApprovals([
        requiresAction([{ id: "appr-2", name: "run_command" }]),
        event("turn.cancelled", {}),
      ]),
    ).toEqual([]);
  });

  test("deleting an unrelated queued turn does not clear the pending approval", () => {
    reset();
    const log = [
      requiresAction([{ id: "appr-1", name: "run_command" }]),
      // The user deletes a *queued* turn while the session waits on approval.
      event("turn.cancelled", {}, { turnId: "queued-turn-9" }),
    ];
    expect(projectPendingApprovals(log).map((approval) => approval.id)).toEqual(["appr-1"]);
  });

  test("an unknown decision id leaves the pending set alone", () => {
    reset();
    const log = [
      requiresAction([{ id: "appr-1", name: "run_command" }]),
      decision("someone-elses-approval"),
      event("user.approvalDecision", { decision: "approve" }, { turnId: null }),
    ];
    expect(projectPendingApprovals(log).map((approval) => approval.id)).toEqual(["appr-1"]);
  });
});
