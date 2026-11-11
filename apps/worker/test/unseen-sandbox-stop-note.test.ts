import { expect, test } from "bun:test";
import { unseenSandboxStopNote } from "../src/activities/run-input";

test("an idle stop names the time and what may be gone, in one sentence", () => {
  expect(
    unseenSandboxStopNote({ kind: "stopped", at: "2026-11-10T12:05:19.312Z", reason: "idle" }),
  ).toBe(
    "Sandbox note: this chat's sandbox was stopped for being idle at 2026-11-10 12:05 UTC, after your last action; files outside /workspace and programs that were running may be gone.",
  );
});

test("other stops and losses do not guess a reason", () => {
  expect(
    unseenSandboxStopNote({ kind: "stopped", at: "2026-11-10T12:05:19Z", reason: "operator" }),
  ).toStartWith("Sandbox note: this chat's sandbox was stopped at 2026-11-10 12:05 UTC, after ");
  expect(
    unseenSandboxStopNote({ kind: "lost", at: "2026-11-10T12:05:19Z", reason: null }),
  ).toStartWith("Sandbox note: this chat's sandbox stopped unexpectedly at 2026-11-10 12:05 UTC, ");
  expect(unseenSandboxStopNote({ kind: "lost", at: "not a time", reason: null })).toStartWith(
    "Sandbox note: this chat's sandbox stopped unexpectedly, after your last action; ",
  );
});
