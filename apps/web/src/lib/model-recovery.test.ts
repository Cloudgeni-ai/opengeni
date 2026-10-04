import { expect, test } from "bun:test";
import type { Session, SessionEvent } from "@/types";
import { currentModelRecovery } from "./model-recovery";
import { admissionRecheckControl } from "@/components/session/session-admission-notice";

const session = {
  id: "session",
  status: "recovering",
  activeTurnId: "turn",
  effectiveControl: { state: "active" },
} as Pick<Session, "id" | "status" | "activeTurnId" | "effectiveControl">;
function event(sequence = 1, payload: unknown = {}): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    type: "turn.recovery.requested",
    sequence,
    payload: { reason: "provider_rate_limited", continueDelayMs: 60_000, ...Object(payload) },
    occurredAt: "2026-10-04T14:00:00.000Z",
  };
}

test("current typed provider recovery exposes only its recovery kind", () => {
  expect(currentModelRecovery(session, [event()])).toEqual({
    kind: "rate_limited",
  });
  expect(currentModelRecovery(session, [event(1, { reason: "provider_unavailable" })])?.kind).toBe(
    "unavailable",
  );
});

test("does not call other recovery causes or raw diagnostics model demand", () => {
  for (const reason of [
    "sandbox_command_start_unavailable",
    "mcp_transport_timeout",
    "codex_usage_limit_reached",
    "provider_quota_exhausted",
    "human_retry",
    "unknown",
  ]) {
    expect(
      currentModelRecovery(session, [event(1, { reason, error: "429 model overloaded" })]),
    ).toBeNull();
  }
  expect(currentModelRecovery(session, [{ ...event(), payload: null }])).toBeNull();
});

test("notice requires live recovering state, active control and the exact current turn", () => {
  for (const status of [
    "running",
    "queued",
    "idle",
    "failed",
    "cancelled",
    "waiting_capacity",
  ] as const)
    expect(currentModelRecovery({ ...session, status }, [event()])).toBeNull();
  expect(currentModelRecovery({ ...session, activeTurnId: null }, [event()])).toBeNull();
  expect(
    currentModelRecovery(
      { ...session, effectiveControl: { ...session.effectiveControl, state: "paused" } },
      [event()],
    ),
  ).toBeNull();
  for (const ignored of [
    { ...event(), sessionId: "other-session" },
    { ...event(), turnId: "other-turn" },
    { ...event(), turnAssociation: "late_rejected" as const },
    { ...event(), duplicateOfEventId: "original" },
  ])
    expect(currentModelRecovery(session, [ignored])).toBeNull();
  expect(currentModelRecovery(session, [])).toBeNull();
});

test("newer boundaries clear stale recovery, regardless of page order", () => {
  for (const type of ["turn.started", "turn.completed", "turn.failed"]) {
    const boundary = { ...event(2), type };
    expect(currentModelRecovery(session, [boundary, event()])).toBeNull();
  }
  expect(
    currentModelRecovery(session, [event(2, { reason: "mcp_transport_timeout" }), event()]),
  ).toBeNull();
  expect(currentModelRecovery(session, [event(2), { ...event(), type: "turn.started" }])).toEqual({
    kind: "rate_limited",
  });
});

test("provider delay and event timestamps never become an ETA or reset promise", () => {
  for (const continueDelayMs of [undefined, null, "60000", -1, 0, NaN, Infinity, 900_001])
    expect(currentModelRecovery(session, [event(1, { continueDelayMs })])).toEqual({
      kind: "rate_limited",
    });
  expect(currentModelRecovery(session, [{ ...event(), occurredAt: "invalid" }])).toEqual({
    kind: "rate_limited",
  });
});

test("a confirmed Pause suppresses retry copy before detail and queue reads catch up", () => {
  const active = { ...session.effectiveControl, state: "active" as const, controlVersion: 1 };
  const paused = { ...active, state: "paused" as const, controlVersion: 2 };
  const events = [event()];
  expect(currentModelRecovery({ ...session, effectiveControl: active }, events)).not.toBeNull();
  for (const staleQueue of [active, undefined, null]) {
    const effectiveControl = admissionRecheckControl(active, staleQueue, paused);
    expect(currentModelRecovery({ ...session, effectiveControl }, events)).toBeNull();
  }
  const resumed = { ...active, controlVersion: 3 };
  expect(
    currentModelRecovery(
      {
        ...session,
        effectiveControl: admissionRecheckControl(active, paused, resumed),
      },
      events,
    ),
  ).not.toBeNull();
});
