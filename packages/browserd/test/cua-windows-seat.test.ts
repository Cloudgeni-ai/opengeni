import { describe, expect, test } from "bun:test";
import { readWindowsSeat, windowsSeatFromStatus } from "../src/cua/windows-seat";

const interactive = {
  sessionId: 2,
  windowStation: "WinSta0",
  desktop: "Default",
  inputDesktop: "Default",
};

describe("Windows CUA seat", () => {
  test("an unlocked interactive session is a login seat", () => {
    expect(windowsSeatFromStatus(interactive)).toEqual({
      seatId: "windows-login-seat:2",
      displayId: "windows:2:WinSta0/Default",
    });
  });

  test.each([
    ["service session 0", { sessionId: 0 }],
    ["another window station", { windowStation: "Service-0x0-3e7$" }],
    ["another thread desktop", { desktop: "Winlogon" }],
    ["a locked screen or secure desktop", { inputDesktop: null }],
    ["the secure desktop receiving input", { inputDesktop: "Winlogon" }],
  ])("%s is refused", (_label, change) => {
    expect(() => windowsSeatFromStatus({ ...interactive, ...change })).toThrow(
      "unlocked interactive user session",
    );
  });

  test.skipIf(process.platform !== "win32")("reads this process's seat quickly", async () => {
    const started = performance.now();
    await readWindowsSeat().catch(() => undefined);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
