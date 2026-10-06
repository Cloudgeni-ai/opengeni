/**
 * User-facing names for where a session's commands run, shared by the web
 * sandbox switcher and every timeline that labels command rows ("on Cloud
 * sandbox · …"). No DOM, no React.
 */
import type { SandboxBackend } from "@opengeni/sdk";
import type { MachineView } from "./types/machines";

export const CLOUD_SANDBOX_LABEL = "Cloud sandbox";
export const NO_SANDBOX_LABEL = "No sandbox";
export const LOCAL_SANDBOX_LABEL = "Local sandbox";

/**
 * User-facing name for a session's own managed box. Hosting vendors (Modal,
 * Daytona, ...) are deployment detail, not something a user chose, so hosted
 * providers read as the neutral "Cloud sandbox" and the local-dev Docker box as
 * "Local sandbox". The local backend runs directly on the host, so it keeps the
 * honest "this computer" instead of implying isolation. Connected Machines keep
 * their own names.
 */
export function sessionSandboxLabel(backend: SandboxBackend | string): string {
  if (backend === "none") return NO_SANDBOX_LABEL;
  if (backend === "local") return "this computer";
  if (backend === "docker") return LOCAL_SANDBOX_LABEL;
  return CLOUD_SANDBOX_LABEL;
}

/** Display name for a fleet row: the session's own box never shows its vendor. */
export function machineDisplayName(
  machine: Pick<MachineView, "isSessionGroup" | "kind" | "name">,
): string {
  return machine.isSessionGroup ? sessionSandboxLabel(machine.kind) : machine.name;
}

/** The compute label a session timeline shows: the active machine, else the cloud box. */
export function sessionComputeLabel(
  machines: readonly Pick<MachineView, "active" | "isSessionGroup" | "kind" | "name">[],
): string {
  const active = machines.find((machine) => machine.active);
  return active ? machineDisplayName(active) : CLOUD_SANDBOX_LABEL;
}
