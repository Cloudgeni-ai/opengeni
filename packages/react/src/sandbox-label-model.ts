/**
 * User-facing names for where a session's commands run, shared by the web
 * sandbox switcher and every timeline that labels command rows ("on Cloud
 * sandbox · …"). No DOM, no React.
 */
import type { SandboxBackend } from "@opengeni/sdk";
import type { MachineView } from "./types/machines";
import { type OpenGeniText } from "./messages/runtime";

export const CLOUD_SANDBOX_LABEL = (t: OpenGeniText) => t("sandboxLabelModel.cloudSandbox");
export const NO_SANDBOX_LABEL = (t: OpenGeniText) => t("sandboxLabelModel.noSandbox");
export const LOCAL_SANDBOX_LABEL = (t: OpenGeniText) => t("sandboxLabelModel.localSandbox");

/**
 * User-facing name for a session's own managed box. Hosting vendors (Modal,
 * Daytona, ...) are deployment detail, not something a user chose, so hosted
 * providers read as the neutral "Cloud sandbox" and the local-dev Docker box as
 * "Local sandbox". The local backend runs directly on the host, so it keeps the
 * honest "this computer" instead of implying isolation. Connected Machines keep
 * their own names.
 */
export function sessionSandboxLabel(t: OpenGeniText, backend: SandboxBackend | string): string {
  if (backend === "none") return NO_SANDBOX_LABEL(t);
  if (backend === "local") return t("sandboxLabelModel.thisComputer");
  if (backend === "docker") return LOCAL_SANDBOX_LABEL(t);
  return CLOUD_SANDBOX_LABEL(t);
}

/** Display name for a fleet row: the session's own box never shows its vendor. */
export function machineDisplayName(
  t: OpenGeniText,
  machine: Pick<MachineView, "isSessionGroup" | "kind" | "name">,
): string {
  return machine.isSessionGroup ? sessionSandboxLabel(t, machine.kind) : machine.name;
}

/**
 * Who can use a Connected Machine, in the words of the Connect dialog's
 * "Who can use it?" choice: a personal machine is "Only me" (its owner, in any
 * workspace they can access), a workspace machine is shared with that
 * workspace's members, and an organization machine with the whole organization.
 */
export function machineScopeLabel(t: OpenGeniText, scope: MachineView["scope"]): string {
  if (scope === "user") return t("sandboxLabelModel.onlyMe");
  if (scope === "organization") return t("sandboxLabelModel.organization");
  return t("sandboxLabelModel.workspace");
}

/** The compute label a session timeline shows: the active machine, else the cloud box. */
export function sessionComputeLabel(
  t: OpenGeniText,
  machines: readonly Pick<MachineView, "active" | "isSessionGroup" | "kind" | "name">[],
): string {
  const active = machines.find((machine) => machine.active);
  return active ? machineDisplayName(t, active) : CLOUD_SANDBOX_LABEL(t);
}
