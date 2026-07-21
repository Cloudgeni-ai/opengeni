import { describe, expect, test } from "bun:test";
import {
  SessionControlRequest,
  WORKSPACE_CONTROL_ACTOR_MAX_BYTES,
  WORKSPACE_CONTROL_EVENT_MAX_BYTES,
  WORKSPACE_CONTROL_REASON_MAX_BYTES,
  WorkspaceInferenceControlRequest,
  boundWorkspaceControlEvent,
  sessionEventJsonBytes,
  workspaceControlUtf8Bytes,
  type WorkspaceControlEvent,
} from "../src";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function controlEvent(overrides: Partial<WorkspaceControlEvent> = {}): WorkspaceControlEvent {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspaceId: WORKSPACE_ID,
    sequence: 7,
    revision: 7,
    type: "workspace.control.changed",
    scope: "workspace",
    rootSessionId: null,
    action: "pause",
    automatic: false,
    reason: "operator pause",
    actor: "operator:test",
    occurredAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("workspace-control bounds", () => {
  test("accepts the exact UTF-8 reason boundary and rejects one byte more or NUL", () => {
    const exact = `${"界".repeat(2730)}xx`;
    expect(workspaceControlUtf8Bytes(exact)).toBe(WORKSPACE_CONTROL_REASON_MAX_BYTES);
    expect(
      SessionControlRequest.parse({
        action: "pause",
        reason: exact,
        clientEventId: "control-exact",
      }).reason,
    ).toBe(exact);
    expect(() =>
      WorkspaceInferenceControlRequest.parse({
        action: "pause",
        reason: `${exact}x`,
        clientEventId: "control-too-large",
      }),
    ).toThrow(`reason must not exceed ${WORKSPACE_CONTROL_REASON_MAX_BYTES} UTF-8 bytes`);
    expect(() =>
      SessionControlRequest.parse({
        action: "pause",
        reason: "bad\u0000reason",
        clientEventId: "control-nul",
      }),
    ).toThrow("reason must not contain NUL bytes");
  });

  test("projects multi-megabyte legacy fields with exact loss facts and a hard envelope", () => {
    const reason = `HEAD-${"🙂".repeat(600_000)}-TAIL`;
    const actor = `actor-${"界".repeat(500_000)}`;
    const bounded = boundWorkspaceControlEvent(controlEvent({ reason, actor }), {
      surface: "database_guard",
    });
    const reasonFact = bounded.truncation?.fields.find((field) => field.field === "reason");
    const actorFact = bounded.truncation?.fields.find((field) => field.field === "actor");

    expect(workspaceControlUtf8Bytes(bounded.reason!)).toBeLessThanOrEqual(
      WORKSPACE_CONTROL_REASON_MAX_BYTES,
    );
    expect(workspaceControlUtf8Bytes(bounded.actor)).toBeLessThanOrEqual(
      WORKSPACE_CONTROL_ACTOR_MAX_BYTES,
    );
    expect(bounded.reason).toStartWith("HEAD-");
    expect(bounded.reason).toEndWith("…[truncated]");
    expect(bounded.actor).toStartWith("actor-");
    expect(bounded.actor).toEndWith("…[truncated]");
    expect(reasonFact).toEqual({
      field: "reason",
      originalBytes: workspaceControlUtf8Bytes(reason),
      deliveredBytes: workspaceControlUtf8Bytes(bounded.reason!),
      omittedBytes: workspaceControlUtf8Bytes(reason) - workspaceControlUtf8Bytes(bounded.reason!),
    });
    expect(actorFact).toEqual({
      field: "actor",
      originalBytes: workspaceControlUtf8Bytes(actor),
      deliveredBytes: workspaceControlUtf8Bytes(bounded.actor),
      omittedBytes: workspaceControlUtf8Bytes(actor) - workspaceControlUtf8Bytes(bounded.actor),
    });
    expect(bounded.truncation).toMatchObject({
      truncated: true,
      surface: "database_guard",
      deliveredBytes: sessionEventJsonBytes(bounded),
      fullEvidence: { available: false, reason: "not_retained" },
    });
    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(WORKSPACE_CONTROL_EVENT_MAX_BYTES);
  });

  test("is idempotent and preserves original byte truth across defensive projections", () => {
    const original = controlEvent({
      reason: "🙂".repeat(10_000),
      actor: "界".repeat(10_000),
    });
    const first = boundWorkspaceControlEvent(original, { surface: "durable_control" });
    const second = boundWorkspaceControlEvent(first, { surface: "http_projection" });

    expect(second).toEqual(first);
    expect(second.truncation?.surface).toBe("durable_control");
    expect(second.truncation?.deliveredBytes).toBe(sessionEventJsonBytes(second));
  });
});
