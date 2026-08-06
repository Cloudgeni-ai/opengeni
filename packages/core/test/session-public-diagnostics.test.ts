import { expect, test } from "bun:test";
import { reportSessionUsageRecordingFailure } from "../src/domain/sessions";

test("session create usage-recording warnings omit identifiers and exact errors", () => {
  const sentinel = "SECRET_SENTINEL_123_workspace_session_turn";
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    reportSessionUsageRecordingFailure(
      Object.assign(new Error(`usage backend failed: ${sentinel}`), {
        workspaceId: sentinel,
        sessionId: sentinel,
      }),
    );
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings).toEqual([
    [
      "[sessions] usage recording failed after committed session create; returning committed outcome",
      {
        errorClass: "UsageRecordingError",
        errorCode: "session_create_usage_recording_failed",
        origin: "core",
      },
    ],
  ]);
  expect(JSON.stringify(warnings)).not.toContain(sentinel);
});
