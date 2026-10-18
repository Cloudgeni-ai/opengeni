import { describe, expect, test } from "bun:test";
import type { ScheduledTaskBlockerFacts, ScheduledTaskBlockerRun } from "@opengeni/db";
import {
  decideScheduledTaskBlocker,
  SCHEDULED_TASK_BLOCKER_STREAK,
} from "../src/scheduled-task-blockers";

const taskId = "11111111-1111-4111-8111-111111111111";
const chatId = "22222222-2222-4222-8222-222222222222";
const edited = new Date("2026-10-01T00:00:00Z");

let sequence = 0;
function run(
  status: string,
  overrides: Partial<ScheduledTaskBlockerRun> = {},
): ScheduledTaskBlockerRun {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    status,
    error: null,
    admissionRefusal: null,
    admissionDiagnostic: null,
    sessionId: null,
    createdAt: new Date(edited.getTime() + sequence * 60_000),
    ...overrides,
  };
}

function facts(
  runs: ScheduledTaskBlockerRun[],
  overrides: {
    task?: Partial<ScheduledTaskBlockerFacts["task"]>;
    review?: ScheduledTaskBlockerFacts["review"];
  } = {},
): ScheduledTaskBlockerFacts {
  return {
    task: {
      id: taskId,
      accountId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      name: "Morning review",
      status: "active",
      deleted: false,
      runMode: "reusable_session",
      reusableSessionId: chatId,
      updatedAt: edited,
      ...overrides.task,
    },
    review: overrides.review ?? null,
    // Newest first, like the database read.
    runs: [...runs].reverse(),
  };
}

function review(
  state: "clear" | "notified" | "paused",
  reviewedRunId: string | null,
): NonNullable<ScheduledTaskBlockerFacts["review"]> {
  return {
    reviewedRunId,
    state,
    reason: state === "clear" ? null : "scheduled_session_not_idle",
    message: state === "clear" ? null : "…",
    blockedRunId: state === "clear" ? null : reviewedRunId,
    blockedSince: state === "clear" ? null : edited,
    noticeSessionId: state === "clear" ? null : chatId,
    noticeKey: state === "clear" ? null : `schedule-${taskId}`,
    noticePending: null,
  };
}

describe("decideScheduledTaskBlocker", () => {
  test("a paused chat pauses the schedule and tells the owner in that chat", () => {
    const blocked = run("skipped", { error: "scheduled_session_paused" });
    const decision = decideScheduledTaskBlocker(facts([run("succeeded"), blocked]));
    expect(decision).toMatchObject({
      kind: "block",
      state: "paused",
      reason: "scheduled_session_paused",
      blockedRunId: blocked.id,
      reviewedRunId: blocked.id,
      notice: { sessionId: chatId, key: `schedule-${taskId}` },
    });
    if (decision.kind !== "block") throw new Error("expected a block");
    expect(decision.message).toContain("Resume the chat, then resume the schedule.");
    expect(decision.notice?.payload).toMatchObject({
      title: "Schedule paused itself",
      subtitle: "Morning review",
      urgency: "normal",
    });
  });

  test("an unavailable pinned account or a non-retryable refusal pauses at once", () => {
    const account = run("failed", {
      error: "connection_account_unavailable",
      admissionDiagnostic: { version: 1, reason: "selected_account_unavailable", accounts: [] },
    });
    expect(decideScheduledTaskBlocker(facts([account]))).toMatchObject({
      kind: "block",
      state: "paused",
      reason: "connection_account_unavailable",
    });
    const machine = run("failed", {
      error: "machine_enrollment_inactive",
      admissionRefusal: { reason: "machine_enrollment_inactive", retryable: false },
    });
    expect(decideScheduledTaskBlocker(facts([machine]))).toMatchObject({
      kind: "block",
      state: "paused",
      reason: "machine_enrollment_inactive",
    });
  });

  test("one ended chat does not block a schedule that starts a new chat each run", () => {
    const ended = run("skipped", { error: "session_cancelled", sessionId: chatId });
    expect(
      decideScheduledTaskBlocker(
        facts([ended], { task: { runMode: "new_session_per_run", reusableSessionId: null } }),
      ),
    ).toEqual({ kind: "none", reviewedRunId: ended.id });
    expect(decideScheduledTaskBlocker(facts([ended]))).toMatchObject({
      kind: "block",
      state: "paused",
      reason: "session_cancelled",
    });
  });

  test("transient failures notify only after a streak, and never pause", () => {
    const busy = Array.from({ length: SCHEDULED_TASK_BLOCKER_STREAK }, () =>
      run("skipped", { error: "scheduled_session_not_idle" }),
    );
    expect(decideScheduledTaskBlocker(facts(busy.slice(0, -1)))).toMatchObject({ kind: "none" });
    const decision = decideScheduledTaskBlocker(facts([run("succeeded"), ...busy]));
    expect(decision).toMatchObject({
      kind: "block",
      state: "notified",
      reason: "scheduled_session_not_idle",
      blockedRunId: busy[0]!.id,
      reviewedRunId: busy.at(-1)!.id,
      notice: { payload: { title: "Schedule needs attention" } },
    });
    if (decision.kind !== "block") throw new Error("expected a block");
    expect(decision.message).toContain("The last 3 scheduled runs were skipped");
  });

  test("a streak before the last edit or resume does not count", () => {
    const old = Array.from({ length: SCHEDULED_TASK_BLOCKER_STREAK }, () =>
      run("failed", { error: "scheduled_turn_failed" }),
    );
    const decision = decideScheduledTaskBlocker(
      facts(old, { task: { updatedAt: new Date(old[1]!.createdAt.getTime() + 1) } }),
    );
    expect(decision).toEqual({ kind: "none", reviewedRunId: old.at(-1)!.id });
  });

  test("an already notified streak stays quiet until a run succeeds, then the notice goes", () => {
    const failed = run("failed", { error: "scheduled_turn_failed" });
    expect(
      decideScheduledTaskBlocker(facts([failed], { review: review("notified", "x") })),
    ).toEqual({ kind: "none", reviewedRunId: failed.id });
    const ok = run("succeeded");
    expect(
      decideScheduledTaskBlocker(facts([failed, ok], { review: review("notified", failed.id) })),
    ).toEqual({ kind: "clear", reviewedRunId: ok.id });
  });

  test("a person resuming, pausing or deleting the schedule clears its blocker", () => {
    const blocked = run("skipped", { error: "scheduled_session_paused" });
    expect(
      decideScheduledTaskBlocker(facts([blocked], { review: review("paused", blocked.id) })),
    ).toEqual({ kind: "clear", reviewedRunId: null });
    expect(
      decideScheduledTaskBlocker(
        facts([blocked], { task: { status: "paused" }, review: review("notified", blocked.id) }),
      ),
    ).toEqual({ kind: "clear", reviewedRunId: null });
    expect(
      decideScheduledTaskBlocker(
        facts([blocked], {
          task: { status: "paused", deleted: true },
          review: review("paused", blocked.id),
        }),
      ),
    ).toEqual({ kind: "clear", reviewedRunId: null });
  });

  test("a reviewed, unsettled or manually paused run is left alone", () => {
    const blocked = run("skipped", { error: "scheduled_session_paused" });
    expect(
      decideScheduledTaskBlocker(facts([blocked], { review: review("clear", blocked.id) })),
    ).toEqual({ kind: "none", reviewedRunId: null });
    expect(decideScheduledTaskBlocker(facts([blocked, run("dispatched")]))).toEqual({
      kind: "none",
      reviewedRunId: null,
    });
    expect(decideScheduledTaskBlocker(facts([blocked], { task: { status: "paused" } }))).toEqual({
      kind: "none",
      reviewedRunId: null,
    });
  });

  test("without any chat to carry it, the blocker is still recorded", () => {
    const blocked = run("failed", {
      error: "scheduled_model_unavailable",
      admissionRefusal: { reason: "scheduled_model_unavailable", retryable: false },
    });
    expect(
      decideScheduledTaskBlocker(
        facts([blocked], { task: { runMode: "new_session_per_run", reusableSessionId: null } }),
      ),
    ).toMatchObject({ kind: "block", state: "paused", notice: null });
  });
});
