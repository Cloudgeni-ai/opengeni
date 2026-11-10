import { expect, test } from "bun:test";
import { unseenSandboxStopNote } from "../src/activities/run-input";

test("an idle stop names the time and says only /workspace was kept", () => {
  expect(
    unseenSandboxStopNote({ kind: "stopped", at: "2026-11-10T12:05:19.312Z", reason: "idle" }),
  ).toBe(
    "Sandbox note: this chat's sandbox was stopped at 2026-11-10 12:05 UTC because it was idle; commands now run in a replacement restored from its saved /workspace. Only /workspace is kept: files elsewhere (such as /tmp), tools installed outside /workspace, and programs or background commands that were running are gone. Recreate what you still need before relying on it.",
  );
});

test("other stops and losses do not guess a reason", () => {
  expect(
    unseenSandboxStopNote({ kind: "stopped", at: "2026-11-10T12:05:19Z", reason: "operator" }),
  ).toStartWith("Sandbox note: this chat's sandbox was stopped at 2026-11-10 12:05 UTC; ");
  expect(
    unseenSandboxStopNote({ kind: "lost", at: "2026-11-10T12:05:19Z", reason: null }),
  ).toStartWith("Sandbox note: this chat's sandbox stopped unexpectedly at 2026-11-10 12:05 UTC; ");
  expect(unseenSandboxStopNote({ kind: "lost", at: "not a time", reason: null })).toStartWith(
    "Sandbox note: this chat's sandbox stopped unexpectedly; ",
  );
});
