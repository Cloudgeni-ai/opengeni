import { expect, test } from "bun:test";
import type { SessionEvent } from "@/types";
import { summarizeSessionFailure } from "./events";

function event(sequence: number, type: string, payload: unknown, turnId = "turn-1"): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace",
    sessionId: "session",
    turnId,
    sequence,
    type,
    payload,
    occurredAt: "2026-09-20T08:00:00.000Z",
  };
}
const provision = event(1, "sandbox.operation.failed", {
  name: "sandbox.provision",
  failureCategory: "archive_recovery",
  failureCode: "restore_degraded",
});
const failure = event(2, "turn.failed", { error: "Sandbox failed" });

test("same-turn typed provisioning evidence survives failure summarization", () => {
  expect(summarizeSessionFailure([provision, failure], "failed").structuralSandboxFailure).toBe(
    true,
  );
});

test("unrelated, superseded, duplicated and historical provisioning failures do not classify a new failure", () => {
  for (const older of [
    { ...provision, turnId: "older-turn" },
    { ...provision, duplicateOfEventId: "original" },
    { ...provision, turnAssociation: "late_rejected" as const },
  ]) {
    expect(
      summarizeSessionFailure([older, failure], "failed").structuralSandboxFailure,
    ).toBeUndefined();
  }
  expect(
    summarizeSessionFailure(
      [
        provision,
        event(2, "sandbox.operation.completed", { name: "sandbox.provision" }),
        event(3, "turn.failed", { error: "Model failed" }),
      ],
      "failed",
    ).structuralSandboxFailure,
  ).toBeUndefined();
  expect(
    summarizeSessionFailure(
      [provision, failure, event(3, "turn.failed", { error: "Model failed" }, "turn-2")],
      "failed",
    ).structuralSandboxFailure,
  ).toBeUndefined();
});

test("detail diagnostics classify structural failures even with cleared history", () => {
  for (const payload of [
    { failureCategory: "archive_recovery" },
    { code: "restore_degraded" },
    { failureCode: "unrecoverable" },
  ]) {
    const summary = summarizeSessionFailure([], "failed", {
      eventId: failure.id,
      sequence: 2,
      turnId: failure.turnId ?? null,
      occurredAt: failure.occurredAt,
      payload,
    });
    expect(summary.structuralSandboxFailure).toBe(true);
  }
});

test("newer nonstructural failure clears structural diagnostic classification", () => {
  expect(
    summarizeSessionFailure(
      [event(3, "turn.failed", { error: "Model failure" }, "new-turn")],
      "failed",
      {
        eventId: failure.id,
        sequence: 2,
        turnId: failure.turnId ?? null,
        occurredAt: failure.occurredAt,
        payload: { failureCategory: "archive_recovery" },
      },
    ).structuralSandboxFailure,
  ).toBeUndefined();
});

test("structural-sounding error text is never a typed recovery classification", () => {
  expect(
    summarizeSessionFailure(
      [event(1, "turn.failed", { error: "archive_recovery unrecoverable restore_degraded" })],
      "failed",
    ).structuralSandboxFailure,
  ).toBeUndefined();
});
