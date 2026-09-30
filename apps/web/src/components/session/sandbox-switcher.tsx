import { useWorkspaceMachines } from "@/lib/use-workspace-machines";
// Where a running chat runs. "+" > Runs on shows the session's active machine
// and live-swaps it to any online machine (the session's own box + the enrolled
// selfhosted machines) through `useWorkspaceMachines({ sessionId })`, whose
// `attach(sandboxId)` performs the swap and re-polls the pointer. The header
// keeps only a read-only "on <machine>" when the chat runs on a person's own
// machine. When selfhosted is disabled the machines API 404s and the list is
// empty, so the drill-in just names the compute.
import { MACHINES_SESSION_POLL_MS, type MachineView } from "@opengeni/react/machines";
import type { SandboxBackend } from "@opengeni/sdk";
import { LaptopIcon, Loader2Icon, ServerIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { ComposerMenuHeader } from "@/components/ui/composer-menu";
import {
  MENU_LABEL_CLASS,
  MENU_NOTE_CLASS,
  MENU_SEPARATOR_CLASS,
} from "@/components/ui/menu-styles";
import { userErrorText } from "@/lib/api-error";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";
import { cn } from "@/lib/utils";
import {
  RadioGroup,
  RadioRow,
  useFocusCheckedRow,
  type MenuBodyPresentation,
} from "./composer-menu-radio";

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
export function machineDisplayName(machine: Pick<MachineView, "isSessionGroup" | "kind" | "name">) {
  return machine.isSessionGroup ? sessionSandboxLabel(machine.kind) : machine.name;
}

function SandboxMark({
  kind,
  backend,
  className = "size-3",
}: {
  kind: string | undefined;
  backend: SandboxBackend;
  className?: string;
}) {
  const local = kind === "local" || (kind === undefined && backend === "local");
  const Icon = local ? LaptopIcon : ServerIcon;
  return <Icon className={cn("shrink-0", className)} />;
}

export function sessionSupportsFleetSwitching(_sandboxBackend: SandboxBackend): boolean {
  return true;
}

/** Whether a machine can be a swap target right now (the active one always can,
 *  since selecting it is a harmless no-op; otherwise it must be compute-selectable). */
function isSelectable(machine: MachineView): boolean {
  return machine.active || isMachineComputeSelectable(machine.state);
}

/** The session's compute: which box or machine it runs on, and what it may swap to. */
export function useSessionRunsOn(sessionId: string, sandboxBackend: SandboxBackend) {
  const fleet = useWorkspaceMachines({ sessionId, pollIntervalMs: MACHINES_SESSION_POLL_MS });
  const machines = fleet.machines;
  const activeMachine = machines.find((machine) => machine.active) ?? null;
  const activeName = activeMachine
    ? machineDisplayName(activeMachine)
    : sessionSandboxLabel(sandboxBackend);
  const hasChoices =
    fleet.canAttach && machines.some((machine) => !machine.active && isSelectable(machine));
  return { fleet, machines, activeMachine, activeName, hasChoices, sandboxBackend };
}

export type SessionRunsOn = ReturnType<typeof useSessionRunsOn>;

/**
 * "+" > Runs on for a running chat: where it runs now, and the machines it can
 * move to. The Sandbox Environment is fixed once the sandbox exists, so it is
 * shown, not chosen.
 */
export function SessionRunsOnMenuBody(props: {
  leading?: ReactNode;
  presentation?: MenuBodyPresentation;
  runsOn: SessionRunsOn;
  workspaceId: string;
  rigId: string | null;
}) {
  const { fleet, machines } = props.runsOn;
  const presentation = props.presentation ?? "menu";
  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusCheckedRow(bodyRef, presentation);
  const rigs = useWorkspaceRigs({ workspaceId: props.workspaceId, enabled: props.rigId !== null });
  const rig = props.rigId ? rigs.rigs.find((candidate) => candidate.id === props.rigId) : null;
  return (
    <>
      <ComposerMenuHeader title="Runs on" leading={props.leading} />
      <div ref={bodyRef} className="min-h-0 overflow-y-auto overscroll-contain pb-1">
        <RadioGroup
          presentation={presentation}
          label="Runs on"
          value={props.runsOn.activeMachine?.sandboxId ?? "current"}
        >
          {props.runsOn.activeMachine === null ? (
            // No listed box is active (e.g. no sandbox): still say where it runs now.
            <RadioRow
              value="current"
              disabled
              className="disabled:opacity-100 data-[disabled]:opacity-100"
              label={props.runsOn.activeName}
              onSelect={() => {}}
              icon={
                <SandboxMark
                  kind={undefined}
                  backend={props.runsOn.sandboxBackend}
                  className="size-4"
                />
              }
            />
          ) : null}
          {machines.map((machine) => {
            const selectable = isSelectable(machine) && fleet.canAttach;
            const swapping = fleet.attachingSandboxId === machine.sandboxId;
            return (
              <RadioRow
                key={machine.sandboxId}
                value={machine.sandboxId}
                disabled={!selectable || fleet.attaching}
                onSelect={() => {
                  if (machine.active || !selectable || fleet.attaching) return;
                  void fleet.attach(machine.sandboxId);
                }}
                label={machineDisplayName(machine)}
                meta={
                  machine.state !== "online" && !machine.active
                    ? machineStateLabel(machine.state)
                    : undefined
                }
                icon={
                  swapping ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <SandboxMark
                      kind={machine.kind}
                      backend={props.runsOn.sandboxBackend}
                      className="size-4"
                    />
                  )
                }
              />
            );
          })}
        </RadioGroup>
        {fleet.mutationError ? (
          <p role="alert" className={cn(MENU_NOTE_CLASS, "text-danger")}>
            Couldn't move this chat. {userErrorText(fleet.mutationError)}
          </p>
        ) : null}
        {props.rigId ? (
          <>
            <div className={MENU_SEPARATOR_CLASS} />
            <p className={MENU_LABEL_CLASS}>Sandbox environment</p>
            <p className={cn(MENU_NOTE_CLASS, "flex items-center justify-between gap-3 pt-0.5")}>
              <span className="truncate text-fg">{rig?.name ?? "Set for this chat"}</span>
              <span className="shrink-0 text-xs">Fixed for this chat</span>
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}

function machineStateLabel(state: string): string {
  if (state === "offline") return "Offline";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "display_unavailable") return "No display";
  return state;
}

/**
 * The session header names the compute only when the chat runs on someone's
 * own machine, where knowing it matters. Changing it lives under "+" > Runs on.
 */
export function SessionComputeIndicator({
  sessionId,
  sandboxBackend,
}: {
  sessionId: string;
  sandboxBackend: SandboxBackend;
}) {
  const runsOn = useSessionRunsOn(sessionId, sandboxBackend);
  const machine = runsOn.activeMachine;
  if (!machine || machine.isSessionGroup) return null;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 truncate text-2xs text-fg-muted"
      title="Change it under + > Runs on"
    >
      <SandboxMark kind={machine.kind} backend={sandboxBackend} />
      <span className="shrink-0">on</span>
      <span className="truncate">{machineDisplayName(machine)}</span>
    </span>
  );
}
