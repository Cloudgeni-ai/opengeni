export type ConnectedMachineComputerAccessState = {
  hasDisplay: boolean;
  desktopUnavailableReason: string | null;
  allowScreenControl: boolean;
  /** The machine's OS, when known: a desktop OS without a reason is asleep or
   *  signed out rather than headless. */
  os?: string | null;
};

export type ConnectedMachineComputerAccessError = {
  status: 403 | 409;
  message: string;
};

/** A headless machine is often the chat's own workstation, not the person's computer;
 *  say so where the failure happens so the agent looks for their screen instead of
 *  telling them their computer has no display. */
const OTHER_COMPUTER_HINT =
  "This is the machine the session is working on, which may not be the person's own computer: " +
  "if they mean another computer, find it with sandboxes_list, sandbox_swap to it, and open the screen there.";

function machineLabel(machineName: string | null | undefined): string {
  const name = machineName?.trim();
  return name ? `"${name}"` : "this machine";
}

/** Keep passive desktop viewing separate from input consent. `machineName`
 *  names the machine that was checked: a chat can be on another machine than
 *  the one the agent means. */
export function connectedMachineComputerAccessError(
  state: ConnectedMachineComputerAccessState,
  requiresControl: boolean,
  machineName?: string | null,
): ConnectedMachineComputerAccessError | null {
  if (!state.hasDisplay) {
    const reason = state.desktopUnavailableReason?.trim();
    const machine = machineLabel(machineName);
    if (reason) {
      return {
        status: 409,
        message: `Connected Machine desktop is unavailable on ${machine}. ${reason}`,
      };
    }
    if (state.os === "macos" || state.os === "windows") {
      return {
        status: 409,
        message:
          `Connected Machine desktop is unavailable on ${machine}: it reports no screen it can capture, ` +
          "usually because its displays are asleep or no one is signed in to its desktop. " +
          "It works again once the displays are awake and someone is signed in. " +
          OTHER_COMPUTER_HINT,
      };
    }
    return {
      status: 409,
      message: `Connected Machine desktop is unavailable because ${machine} has no capturable display. ${OTHER_COMPUTER_HINT}`,
    };
  }
  if (requiresControl && !state.allowScreenControl) {
    return {
      status: 403,
      message:
        "Screen control is not enabled for this Connected Machine. Turn it on in place with connected_machine_enable_screen_control (no reconnect or human click needed), then retry.",
    };
  }
  return null;
}
