import { expect, test } from "bun:test";
import { scheduledRunErrorText, scheduledRunSkippedForPausedChat } from "./scheduled-run-error";

test("paused chat is a specific actionable skip, distinct from a busy chat", () => {
  expect(scheduledRunErrorText("scheduled_session_paused")).toContain("resume it");
  expect(scheduledRunErrorText("scheduled_session_paused")).toContain(
    "skipped runs are not replayed",
  );
  expect(scheduledRunErrorText("scheduled_session_not_idle")).toContain("busy");
  expect(
    scheduledRunSkippedForPausedChat({ status: "skipped", error: "scheduled_session_paused" }),
  ).toBe(true);
  expect(
    scheduledRunSkippedForPausedChat({ status: "skipped", error: "scheduled_session_not_idle" }),
  ).toBe(false);
  expect(
    scheduledRunSkippedForPausedChat({ status: "dispatched", error: "scheduled_session_paused" }),
  ).toBe(false);
  expect(scheduledRunSkippedForPausedChat(null)).toBe(false);
});
