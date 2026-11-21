import type { AccessGrant, MachineView } from "@opengeni/contracts";
import { browserExtension } from "@opengeni/core";
import { machineSubjectForCaller } from "../sandbox/agent-fleet-context";
import { listMachines, type MachinesServices } from "../sandbox/machines";

/**
 * The computers the person this chat acts for can see, as their Connected
 * Machine card lists them, or null when they can't be read now.
 */
export async function personConnectedMachines(
  deps: MachinesServices,
  grant: AccessGrant,
  sessionId: string,
): Promise<MachineView[] | null> {
  try {
    const subjectId = await machineSubjectForCaller(deps, grant, sessionId, grant.subjectId);
    const { machines } = await listMachines(deps, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId,
      sessionId,
    });
    return machines;
  } catch {
    return null;
  }
}

/**
 * The Chrome extension as an agent should name it: the deployment's own when
 * it configures one, with its link only when that link is for that
 * extension. A deployment that renames the extension without giving its
 * install page gets no link, rather than another product's.
 */
export function browserExtensionForAgents(settings: {
  browserExtensionName?: string | undefined;
  browserExtensionInstallUrl?: string | undefined;
}): { name: string; installUrl: string | null } {
  const extension = browserExtension(settings);
  const linked =
    settings.browserExtensionInstallUrl !== undefined || extension.name === "Opengeni Browser";
  return { name: extension.name, installUrl: linked ? extension.installUrl : null };
}

/** The Chrome line of a Connected Machine result. */
export function browserExtensionSentence(extension: {
  name: string;
  installUrl: string | null;
}): string {
  return `Chrome on a connected computer also needs the ${extension.name} extension${
    extension.installUrl ? ` (${extension.installUrl})` : ""
  }.`;
}

function machineState(state: MachineView["state"]): string {
  switch (state) {
    case "online":
      return "online";
    case "display_unavailable":
      return "online, no screen";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
    case "consent_required":
      return "waiting for its owner to allow it";
    case "enrolling":
      return "still connecting";
  }
}

function machineScope(scope: MachineView["scope"]): string {
  switch (scope) {
    case "user":
      return "personal";
    case "workspace":
      return "shared in this workspace";
    case "organization":
      return "organization";
  }
}

/**
 * What a Connected Machine card result tells the agent when computers are
 * already connected: which of them the person can use and their state, as
 * the card lists them. It claims nothing about how this app lets the person
 * connect another, which depends on the app and the device they're on.
 */
export function connectedMachineCardReadyMessage(
  machines: readonly MachineView[] | null,
  extension: { name: string; installUrl: string | null },
): string {
  if (machines === null) {
    return `The Connected Machine card is in this chat. The person's computers couldn't be read just now. Do not describe the card's buttons or steps. ${browserExtensionSentence(extension)}`;
  }
  const computers = machines.filter((machine) => !machine.isSessionGroup);
  if (computers.length === 0) {
    return "The Connected Machine card is in this chat. None of the person's own computers is connected here, so nothing they can use is ready yet. Do not describe the card's buttons or steps.";
  }
  const listed = computers
    .map(
      (machine) =>
        `${machine.name} (${machineScope(machine.scope)}, ${machineState(machine.state)}${
          machine.active ? ", this chat runs on it" : ""
        })`,
    )
    .join("; ");
  return `The Connected Machine card is in this chat. The person's connected ${
    computers.length === 1 ? "computer" : "computers"
  }: ${listed}. This doesn't show which computer the person is using right now. If they mean that one and it isn't listed, it isn't connected: say so and name the computers that are, instead of quietly using another one. Do not describe the card's buttons or steps. ${browserExtensionSentence(extension)}`;
}
