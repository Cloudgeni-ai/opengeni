import { describe, expect, test } from "bun:test";
import { connectedMachineComputerAccessError } from "../src/connected-machine-computer-access";

describe("connected-machine computer access", () => {
  test("surfaces the agent's actionable display failure on the machine it checked", () => {
    expect(
      connectedMachineComputerAccessError(
        {
          hasDisplay: false,
          desktopUnavailableReason: "Screen Recording permission not granted.",
          allowScreenControl: false,
        },
        false,
        "Work Mac",
      ),
    ).toEqual({
      status: 409,
      message:
        'Connected Machine desktop is unavailable on "Work Mac". Screen Recording permission not granted.',
    });
  });

  test("names the headless machine the chat is on, so the agent looks for the person's screen", () => {
    expect(
      connectedMachineComputerAccessError(
        {
          hasDisplay: false,
          desktopUnavailableReason: null,
          allowScreenControl: true,
          os: "linux",
        },
        false,
        "build-server",
      ),
    ).toEqual({
      status: 409,
      message:
        'Connected Machine desktop is unavailable because "build-server" has no capturable display. ' +
        "This is the machine the session is working on, which may not be the person's own computer: " +
        "if they mean another computer, find it with sandboxes_list, sandbox_swap to it, and open the screen there.",
    });
    expect(
      connectedMachineComputerAccessError(
        { hasDisplay: false, desktopUnavailableReason: null, allowScreenControl: true },
        false,
      )?.message,
    ).toStartWith(
      "Connected Machine desktop is unavailable because this machine has no capturable display.",
    );
  });

  test("a desktop computer without a reason is asleep or signed out, not headless", () => {
    const message = connectedMachineComputerAccessError(
      { hasDisplay: false, desktopUnavailableReason: null, allowScreenControl: true, os: "macos" },
      false,
      "Work Mac",
    )?.message;
    expect(message).toContain('unavailable on "Work Mac"');
    expect(message).toContain("displays are asleep or no one is signed in");
    expect(message).not.toContain("has no capturable display");
  });

  test("allows passive viewing but requires explicit consent for input", () => {
    const state = {
      hasDisplay: true,
      desktopUnavailableReason: null,
      allowScreenControl: false,
    };
    expect(connectedMachineComputerAccessError(state, false)).toBeNull();
    expect(connectedMachineComputerAccessError(state, true)).toEqual({
      status: 403,
      message:
        "Screen control is not enabled for this Connected Machine. Turn it on in place with connected_machine_enable_screen_control (no reconnect or human click needed), then retry.",
    });
  });

  test("allows control when display and consent are present", () => {
    expect(
      connectedMachineComputerAccessError(
        {
          hasDisplay: true,
          desktopUnavailableReason: null,
          allowScreenControl: true,
        },
        true,
      ),
    ).toBeNull();
  });
});
