import { t } from "@/lib/console-text";
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
import { useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { Button } from "@opengeni/react/ui/button";

import { ComposerMenuHeader } from "@opengeni/react/ui/composer-menu";
import {
  MENU_LABEL_CLASS,
  MENU_NOTE_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from "@opengeni/react/ui/menu-styles";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";
import { cn } from "@/lib/utils";
import {
  RadioGroup,
  RadioRow,
  useFocusCheckedRow,
  type MenuBodyPresentation,
} from "./composer-menu-radio";

export {
  CLOUD_SANDBOX_LABEL,
  LOCAL_SANDBOX_LABEL,
  machineDisplayName,
  NO_SANDBOX_LABEL,
  sessionSandboxLabel,
} from "@opengeni/react/sandbox-label-model";
import { machineDisplayName, sessionSandboxLabel } from "@opengeni/react/sandbox-label-model";

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
    ? machineDisplayName(t, activeMachine)
    : (fleet.sessionMachineAccess?.machineName ?? sessionSandboxLabel(t, sandboxBackend));
  const hasChoices =
    fleet.canAttach && machines.some((machine) => !machine.active && isSelectable(machine));
  return { fleet, machines, activeMachine, activeName, hasChoices, sandboxBackend };
}

export type SessionRunsOn = ReturnType<typeof useSessionRunsOn>;

/** The same authorized picker as + → Runs on, reachable from an access notice. */
export function SessionMachinePickerAction(props: {
  runsOn: SessionRunsOn;
  workspaceId: string;
  rigId: string | null;
  move: (machine: MachineView) => Promise<string | null>;
  queuedWork?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!props.runsOn.fleet.canAttach) return null;
  // Accepted messages keep their original personal-resource snapshots. A new
  // consent message cannot retroactively authorize a different personal machine.
  const runsOn = props.queuedWork
    ? {
        ...props.runsOn,
        machines: props.runsOn.machines.filter(
          (machine) => machine.scope !== "user" || machine.isSessionGroup,
        ),
        activeMachine:
          props.runsOn.activeMachine?.scope === "user" ? null : props.runsOn.activeMachine,
      }
    : props.runsOn;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button type="button" className="min-h-11">
          Choose machine
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Choose a machine for this chat"
          className={cn(
            MENU_SURFACE_CLASS,
            "z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-2rem))] flex-col outline-none",
          )}
        >
          <SessionRunsOnMenuBody
            {...props}
            runsOn={runsOn}
            presentation="dialog"
            move={async (machine) => {
              const error = await props.move(machine);
              if (!error) setOpen(false);
              return error;
            }}
          />
          {props.queuedWork ? (
            <p className={MENU_NOTE_CLASS}>
              Use a workspace or cloud machine for the saved message. A new personal-machine
              permission only applies to new messages.
            </p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

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
  /**
   * Moves the chat onto a machine when moving needs more than repointing it
   * (the person's own machine also needs their consent for this chat).
   * Resolves to why the chat could not move, or null.
   */
  move?: ((machine: MachineView) => Promise<string | null>) | undefined;
}) {
  const { fleet, machines } = props.runsOn;
  const presentation = props.presentation ?? "menu";
  const bodyRef = useRef<HTMLDivElement>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // A move onto the person's own machine is a repoint plus a consent message;
  // keep the rows locked until both settle so a second pick can't interleave.
  const [movingSandboxId, setMovingSandboxId] = useState<string | null>(null);
  const locked = fleet.attaching || movingSandboxId !== null;
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
            const swapping =
              fleet.attachingSandboxId === machine.sandboxId ||
              movingSandboxId === machine.sandboxId;
            return (
              <RadioRow
                key={machine.sandboxId}
                value={machine.sandboxId}
                disabled={!selectable || locked}
                onSelect={() => {
                  if (machine.active || !selectable || locked) return;
                  setMoveError(null);
                  if (!props.move) {
                    void fleet.attach(machine.sandboxId);
                    return;
                  }
                  setMovingSandboxId(machine.sandboxId);
                  void props
                    .move(machine)
                    .then(setMoveError, () =>
                      setMoveError(
                        "The machine change could not be confirmed. Refresh the machine list and try again.",
                      ),
                    )
                    .finally(() => setMovingSandboxId(null));
                }}
                label={machineDisplayName(t, machine)}
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
        {moveError ? (
          <p role="alert" className={cn(MENU_NOTE_CLASS, "text-danger")}>
            Couldn't move this chat. {moveError}
          </p>
        ) : fleet.mutationError ? (
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
      <span className="truncate">{machineDisplayName(t, machine)}</span>
    </span>
  );
}
