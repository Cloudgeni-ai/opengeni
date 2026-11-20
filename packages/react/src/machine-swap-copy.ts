// Plain copy for a refused move of a chat onto another machine. Kept apart
// from the machine request model so the web machine hooks stay small.
import type { SwapActiveSandboxResponse } from "@opengeni/sdk";
import { machineAccessNeededMessage } from "@opengeni/contracts/machine-access";
import type { OpenGeniText } from "./messages/runtime";

/**
 * Plain copy for a refused move, chosen by its typed code. The server's
 * `reason` is written for the agent and for logs, so it is never shown here.
 */
export function swapFailureMessage(t: OpenGeniText, result: SwapActiveSandboxResponse): string {
  switch (result.code) {
    case "recovery_in_progress":
      return t("hooks.useMachines.itsComputerIsStillStarting");
    case "recovery_degraded":
      return t("hooks.useMachines.itsComputerIsntWorking");
    case "recovery_unrecoverable":
      return t("hooks.useMachines.itsComputerCouldntBeRestored");
    case "offline_enrollment":
      return t("hooks.useMachines.thatMachineIsOffline");
    case "stale_pointer":
      return t("hooks.useMachines.thatMachineIsNoLonger");
    case "unsupported_backend_context":
    case "transient_establishment":
      return t("hooks.useMachines.thatMachineCouldntBeReached");
    case "concurrent_swap":
      return t("hooks.useMachines.itWasMovedSomewhere");
    case "personal_machine_permission_required":
      return t("hooks.useMachines.theMachineSOwnerHas");
    case "personal_machine_not_permitted":
      return t("hooks.useMachines.onlyTheMachineSOwner");
    // Trying again won't help while the chat isn't allowed to use the machine.
    case "machine_access_required":
      return machineAccessNeededMessage();
    // Neither is fixed by trying again: say what to do instead.
    case "workspace_root_unavailable":
      return t("hooks.useMachines.thatMachineHasntReported");
    case "invalid_working_directory":
      return t("hooks.useMachines.thisChatSWorkingFolder");
    default:
      return t("hooks.useMachines.tryAgain");
  }
}
