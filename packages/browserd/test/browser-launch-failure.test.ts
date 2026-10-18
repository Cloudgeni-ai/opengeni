import { describe, expect, test } from "bun:test";
import { InteractionDefiniteDriverError } from "@opengeni/interaction";

import { AgentBrowserCommandError } from "../src/runner";
import { browserLaunchFailure } from "../src/supervisor";

describe("browser launch failures", () => {
  test("a machine without Chrome is an explicit unsupported placement", () => {
    const failure = browserLaunchFailure(
      new AgentBrowserCommandError(
        "driver_rejected",
        "agent-browser rejected the command",
        "Chrome not found. Checked: - agent-browser cache: /home/u/.agent-browser/browsers - System Chrome installations",
      ),
    );
    expect(failure).toBeInstanceOf(InteractionDefiniteDriverError);
    expect(failure).toMatchObject({ code: "unsupported", retryable: false });
    expect((failure as Error).message).toContain("No Google Chrome or Chromium is installed");
  });

  test("a browser that crashed on startup carries the driver's reason", () => {
    const failure = browserLaunchFailure(
      new AgentBrowserCommandError(
        "driver_rejected",
        "agent-browser rejected the command",
        "Chrome exited early (exit code: 1) without writing DevToolsActivePort",
      ),
    );
    expect(failure).toMatchObject({ code: "driver_failed", retryable: false });
    expect((failure as Error).message).toBe(
      "The browser could not start on this machine: Chrome exited early (exit code: 1) without writing DevToolsActivePort",
    );
  });

  test("other failures keep their own type", () => {
    const silent = new AgentBrowserCommandError("process_failed", "agent-browser process failed");
    const other = new Error("profile is locked");
    expect(browserLaunchFailure(silent)).toBe(silent);
    expect(browserLaunchFailure(other)).toBe(other);
  });
});
