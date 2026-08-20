export type ConnectedMachineComputerAccessState = {
  hasDisplay: boolean;
  desktopUnavailableReason: string | null;
  allowScreenControl: boolean;
};

export type ConnectedMachineComputerAccessError = {
  status: 403 | 409;
  message: string;
};

/** Keep passive desktop viewing separate from input consent. */
export function connectedMachineComputerAccessError(
  state: ConnectedMachineComputerAccessState,
  requiresControl: boolean,
): ConnectedMachineComputerAccessError | null {
  if (!state.hasDisplay) {
    const reason = state.desktopUnavailableReason?.trim();
    return {
      status: 409,
      message: reason
        ? `Connected Machine desktop is unavailable. ${reason}`
        : "Connected Machine desktop is unavailable because this machine has no capturable display.",
    };
  }
  if (requiresControl && !state.allowScreenControl) {
    return {
      status: 403,
      message: "Screen control is not enabled for this Connected Machine.",
    };
  }
  return null;
}
