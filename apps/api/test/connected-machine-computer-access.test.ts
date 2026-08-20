import { describe, expect, test } from "bun:test";
import { connectedMachineComputerAccessError } from "../src/connected-machine-computer-access";

describe("connected-machine computer access", () => {
  test("surfaces the agent's actionable display failure before provisioning", () => {
    expect(
      connectedMachineComputerAccessError(
        {
          hasDisplay: false,
          desktopUnavailableReason: "Screen Recording permission not granted.",
          allowScreenControl: false,
        },
        false,
      ),
    ).toEqual({
      status: 409,
      message: "Connected Machine desktop is unavailable. Screen Recording permission not granted.",
    });
  });

  test("uses a safe fallback for a headless machine", () => {
    expect(
      connectedMachineComputerAccessError(
        {
          hasDisplay: false,
          desktopUnavailableReason: null,
          allowScreenControl: true,
        },
        false,
      ),
    ).toEqual({
      status: 409,
      message:
        "Connected Machine desktop is unavailable because this machine has no capturable display.",
    });
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
      message: "Screen control is not enabled for this Connected Machine.",
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
