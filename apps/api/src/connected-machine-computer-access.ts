export type ConnectedMachineComputerAccessState = {
  hasDisplay: boolean;
  desktopUnavailableReason: string | null;
  allowScreenControl: boolean;
};

export type ConnectedMachineComputerAccessError = {
  status: 403 | 409;
  message: string;
};

/** A headless machine is often the chat's own workstation, not the person's computer;
 *  say so where the failure happens so the agent looks for their screen instead of
 *  telling them their computer has no display. */
const HEADLESS_MESSAGE =
  "Connected Machine desktop is unavailable because this machine has no capturable display. " +
  "This is the machine the session is working on, which may not be the person's own computer: " +
  "if they mean another computer, find it with sandboxes_list, sandbox_swap to it, and open the screen there.";

/** Keep passive desktop viewing separate from input consent. */
export function connectedMachineComputerAccessError(
  state: ConnectedMachineComputerAccessState,
  requiresControl: boolean,
): ConnectedMachineComputerAccessError | null {
  if (!state.hasDisplay) {
    const reason = state.desktopUnavailableReason?.trim();
    return {
      status: 409,
      message: reason ? `Connected Machine desktop is unavailable. ${reason}` : HEADLESS_MESSAGE,
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
