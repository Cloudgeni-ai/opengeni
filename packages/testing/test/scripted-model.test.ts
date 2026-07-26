import { describe, expect, test } from "bun:test";
import { latestExecCommandState } from "../src/scripted-model";

describe("scripted model exec continuation", () => {
  test("polls the latest still-running session with a monotonic occurrence", () => {
    expect(
      latestExecCommandState(
        "Process running with session ID 7\\nOutput:\\nProcess running with session ID 7\\nOutput:\\nstill working",
      ),
    ).toEqual({ status: "running", sessionId: 7, occurrence: 2, index: 44 });
  });

  test("does not revive a historical running banner after completion or session loss", () => {
    expect(
      latestExecCommandState(
        "Process running with session ID 7\\nOutput:\\nProcess exited with code 1\\nOutput:\\nfailed",
      ),
    ).toEqual({ status: "exited", index: 44 });
    expect(
      latestExecCommandState("Process running with session ID 7\\nOutput:\\nSession not found: 7"),
    ).toEqual({ status: "exited", index: 44 });
  });

  test("ignores requests without an exec lifecycle banner", () => {
    expect(latestExecCommandState("plain user prompt")).toBeNull();
  });
});
