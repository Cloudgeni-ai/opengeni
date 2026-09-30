import type { MachineView } from "@opengeni/react/machines";
import type { NewSessionSelectionHistory, Rig } from "@opengeni/sdk";
import { BoxIcon, LaptopIcon, LockIcon, ServerIcon, UsersIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ComposerMenuHeader } from "@/components/ui/composer-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  RadioGroup,
  RadioRow,
  useFocusCheckedRow,
  type MenuBodyPresentation,
} from "./composer-menu-radio";
export type { MenuBodyPresentation } from "./composer-menu-radio";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import {
  MENU_LABEL_CLASS,
  MENU_NOTE_CLASS,
  MENU_SEPARATOR_CLASS,
} from "@/components/ui/menu-styles";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import {
  rememberedMachineFolder,
  workspaceDefaultRigOptionLabel,
  type SessionDraft,
} from "@/lib/session-create";
import { cn } from "@/lib/utils";

/*
 * Per-session settings of a new chat, as drill-ins of the composer's "+" menu:
 * where it runs (managed sandbox and its environment, or a connected machine
 * and its folder) and who can see it. The composer bar keeps only +, voice,
 * the model and Send.
 *
 * Inside the "+" dropdown the rows are Radix radio items, so arrow keys reach
 * them (a Radix menu traps Tab and roves only over its own items). When the
 * "+" menu presents a drill-in as a dialog, there is no menu to rove in, so
 * the rows are plain radio buttons that Tab reaches.
 */

function machineStateMeta(machine: MachineView): string {
  if (machine.state === "offline") return "Offline";
  if (machine.state === "reconnecting") return "Reconnecting";
  if (!isMachineComputeSelectable(machine.state)) return "Unavailable";
  return machine.os ? `${machine.os}/${machine.arch}` : "";
}

export type RunsOnChoices = {
  draft: SessionDraft;
  machines: MachineView[];
  rigs: Rig[];
  workspaceDefaultRigId: string | null;
  /** The deployment runs sessions only on connected machines. */
  selfhostedPrimary: boolean;
  fleetLoadFailed: boolean;
  selectedChannelId: string | null;
  selectionHistory: NewSessionSelectionHistory;
};

/** Whether "Runs on" has anything to choose; otherwise the + menu omits it. */
export function hasRunsOnChoices(
  choices: Pick<RunsOnChoices, "machines" | "rigs" | "selfhostedPrimary" | "fleetLoadFailed">,
): boolean {
  return (
    choices.selfhostedPrimary ||
    choices.fleetLoadFailed ||
    choices.machines.length > 0 ||
    choices.rigs.length > 0
  );
}

/** The right-aligned value of the "Runs on" row: environment or machine. */
export function runsOnSummary(choices: RunsOnChoices): string {
  const { draft } = choices;
  if (draft.compute.kind === "machine") {
    const sandboxId = draft.compute.sandboxId;
    return (
      choices.machines.find((machine) => machine.sandboxId === sandboxId)?.name ??
      "Choose a machine"
    );
  }
  if (draft.rigId) {
    return choices.rigs.find((rig) => rig.id === draft.rigId)?.name ?? "Managed sandbox";
  }
  const fallback = choices.rigs.find((rig) => rig.id === choices.workspaceDefaultRigId);
  return fallback ? fallback.name : "Managed sandbox";
}

/**
 * Why "Runs on" keeps Send disabled, if it does. The choice lives behind "+",
 * so the page says what is missing and where to fix it.
 */
export type RunsOnAttention = "fleet-load-failed" | "connect-machine" | "pick-machine" | null;

export function runsOnAttention(
  choices: Pick<RunsOnChoices, "draft" | "machines" | "fleetLoadFailed"> & {
    fleetLoading: boolean;
  },
): RunsOnAttention {
  // A failed load can hide the machine this chat should run on: always say so.
  if (choices.fleetLoadFailed) return "fleet-load-failed";
  if (choices.fleetLoading) return null;
  const compute = choices.draft.compute;
  if (compute.kind !== "machine" || compute.sandboxId !== null) return null;
  return choices.machines.length === 0 ? "connect-machine" : "pick-machine";
}

/** A short note under the new-chat composer for what {@link runsOnAttention} found. */
export function RunsOnNotice(props: {
  attention: RunsOnAttention;
  machines: MachineView[];
  disabled?: boolean;
  onRetryMachines: () => void;
  /** Where to connect a machine (a link to the Machines page). */
  connectAction?: ReactNode;
}) {
  if (!props.attention) return null;
  if (props.attention === "fleet-load-failed") {
    return (
      <Notice
        tone="muted"
        live="polite"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.disabled}
            onClick={props.onRetryMachines}
          >
            Retry
          </Button>
        }
      >
        Couldn't load your connected machines.
      </Notice>
    );
  }
  if (props.attention === "connect-machine") {
    return (
      <Notice tone="waiting" live="polite" action={props.connectAction}>
        Chats here run on a connected machine. Connect one to send.
      </Notice>
    );
  }
  const anyAvailable = props.machines.some((machine) => isMachineComputeSelectable(machine.state));
  return (
    <Notice tone="waiting" live="polite">
      {anyAvailable
        ? "Pick a machine under + > Runs on to send."
        : "Your connected machines are offline. Pick one under + > Runs on once it's back."}
    </Notice>
  );
}

const SANDBOX_VALUE = "sandbox";
const machineValue = (sandboxId: string) => `machine:${sandboxId}`;

/**
 * The checked "Sandbox environment" row. An empty rigId follows the workspace
 * default, and so does a restored draft that names the default explicitly:
 * the default isn't listed again, so its row is "Workspace default".
 */
export function checkedRigValue(draft: SessionDraft, workspaceDefaultRigId: string | null): string {
  if (!draft.rigId) return "";
  return draft.rigId === workspaceDefaultRigId ? "" : draft.rigId;
}

export function RunsOnMenuBody(
  props: RunsOnChoices & {
    leading?: ReactNode;
    presentation?: MenuBodyPresentation;
    disabled: boolean;
    onChange: (draft: SessionDraft) => void;
    onComputeChange: (draft: SessionDraft) => void;
    onRetryMachines: () => void;
  },
) {
  const { draft } = props;
  const compute = draft.compute;
  const presentation = props.presentation ?? "menu";
  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusCheckedRow(bodyRef, presentation);
  const customPathRowRef = useRef<HTMLElement>(null);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const focusCustomPath = useRef(false);
  useEffect(() => {
    if (focusCustomPath.current && customPathInputRef.current) {
      focusCustomPath.current = false;
      customPathInputRef.current.focus({ preventScroll: true });
    }
  }, [compute]);
  const personalRigs = props.rigs.filter((rig) => rig.scope === "user");
  const workspaceRigs = props.rigs.filter((rig) => rig.scope !== "user");
  const showWhere = props.selfhostedPrimary || props.machines.length > 0 || props.fleetLoadFailed;
  const whereValue =
    compute.kind === "sandbox"
      ? props.selfhostedPrimary
        ? null
        : SANDBOX_VALUE
      : compute.sandboxId
        ? machineValue(compute.sandboxId)
        : null;

  const selectSandbox = () => {
    if (compute.kind === "sandbox") return;
    props.onComputeChange({ ...draft, compute: { kind: "sandbox", backend: "" } });
  };
  const selectMachine = (machine: MachineView) => {
    if (compute.kind === "machine" && compute.sandboxId === machine.sandboxId) return;
    props.onComputeChange({
      ...draft,
      compute: {
        kind: "machine",
        sandboxId: machine.sandboxId,
        folder: rememberedMachineFolder(
          props.selectionHistory,
          props.selectedChannelId,
          machine.sandboxId,
        ),
      },
    });
  };
  const rigRow = (rig: Rig) => (
    <RadioRow
      key={rig.id}
      value={rig.id}
      disabled={props.disabled}
      label={rig.name}
      meta={rig.activeVersion ? `v${rig.activeVersion.version}` : undefined}
      onSelect={() => props.onChange({ ...draft, rigId: rig.id })}
    />
  );
  const retry =
    presentation === "menu" ? (
      <DropdownMenuItem
        className="min-h-0 w-auto shrink-0 cursor-pointer px-1 py-0 text-xs font-medium text-fg underline underline-offset-2 pointer-coarse:min-h-0"
        onSelect={(event) => {
          event.preventDefault();
          props.onRetryMachines();
        }}
      >
        Try again
      </DropdownMenuItem>
    ) : (
      <button
        type="button"
        className="text-xs font-medium text-fg underline underline-offset-2"
        onClick={props.onRetryMachines}
      >
        Try again
      </button>
    );

  return (
    <>
      <ComposerMenuHeader title="Runs on" leading={props.leading} />
      <div ref={bodyRef} className="min-h-0 overflow-y-auto overscroll-contain pb-1">
        {showWhere ? (
          <RadioGroup presentation={presentation} label="Where" value={whereValue}>
            <p className={MENU_LABEL_CLASS}>Where</p>
            {props.selfhostedPrimary ? null : (
              <RadioRow
                value={SANDBOX_VALUE}
                disabled={props.disabled}
                icon={<BoxIcon />}
                label="Managed sandbox"
                meta="Set up for you"
                onSelect={selectSandbox}
              />
            )}
            {props.machines.map((machine) => (
              <RadioRow
                key={machine.sandboxId}
                value={machineValue(machine.sandboxId)}
                disabled={props.disabled || !isMachineComputeSelectable(machine.state)}
                icon={machine.os === "macos" ? <LaptopIcon /> : <ServerIcon />}
                label={machine.name}
                meta={machineStateMeta(machine)}
                onSelect={() => selectMachine(machine)}
              />
            ))}
            {props.fleetLoadFailed ? (
              <div className={cn(MENU_NOTE_CLASS, "flex items-center justify-between gap-3")}>
                <span>Couldn't load your connected machines.</span>
                {retry}
              </div>
            ) : props.machines.length === 0 && props.selfhostedPrimary ? (
              <p className={MENU_NOTE_CLASS}>Connect a machine to run sessions on it.</p>
            ) : null}
          </RadioGroup>
        ) : null}

        {compute.kind === "sandbox" && props.rigs.length > 0 ? (
          <RadioGroup
            presentation={presentation}
            label="Sandbox environment"
            value={checkedRigValue(draft, props.workspaceDefaultRigId)}
          >
            {showWhere ? <div className={MENU_SEPARATOR_CLASS} /> : null}
            <p className={MENU_LABEL_CLASS}>Sandbox environment</p>
            <RadioRow
              value=""
              disabled={props.disabled}
              label={workspaceDefaultRigOptionLabel(props.workspaceDefaultRigId, props.rigs)}
              onSelect={() => props.onChange({ ...draft, rigId: "" })}
            />
            {workspaceRigs.filter((rig) => rig.id !== props.workspaceDefaultRigId).map(rigRow)}
            {personalRigs.length > 0 ? (
              <>
                <p className={MENU_LABEL_CLASS}>Only me</p>
                {personalRigs.map(rigRow)}
              </>
            ) : null}
          </RadioGroup>
        ) : null}

        {compute.kind === "machine" && compute.sandboxId ? (
          <RadioGroup presentation={presentation} label="Folder" value={compute.folder.kind}>
            <div className={MENU_SEPARATOR_CLASS} />
            <p className={MENU_LABEL_CLASS}>Folder</p>
            <RadioRow
              value="root"
              disabled={props.disabled}
              label="Machine root"
              meta="Where the agent was started"
              onSelect={() =>
                props.onComputeChange({
                  ...draft,
                  compute: { ...compute, folder: { kind: "root" } },
                })
              }
            />
            <RadioRow
              value="path"
              ref={(node) => {
                customPathRowRef.current = node;
              }}
              disabled={props.disabled}
              label="Custom path"
              onSelect={() => {
                focusCustomPath.current = true;
                props.onComputeChange({
                  ...draft,
                  compute: {
                    ...compute,
                    folder: {
                      kind: "path",
                      path: compute.folder.kind === "path" ? compute.folder.path : "",
                    },
                  },
                });
              }}
            />
            {compute.folder.kind === "path" ? (
              <div className="px-2.5 pt-1 pb-1.5">
                <Input
                  ref={customPathInputRef}
                  value={compute.folder.path}
                  disabled={props.disabled}
                  onChange={(event) =>
                    props.onComputeChange({
                      ...draft,
                      compute: { ...compute, folder: { kind: "path", path: event.target.value } },
                    })
                  }
                  onKeyDown={(event) => {
                    // Text editing must not trigger menu typeahead or roving focus.
                    event.stopPropagation();
                    if (
                      presentation === "menu" &&
                      !event.nativeEvent.isComposing &&
                      (event.key === "Tab" || event.key === "Enter")
                    ) {
                      event.preventDefault();
                      customPathRowRef.current?.focus({ preventScroll: true });
                    }
                  }}
                  placeholder="/home/me/repos/project or packages/runtime"
                  aria-label="Custom working directory"
                  className="h-8 text-sm"
                />
              </div>
            ) : null}
            <p className={cn(MENU_NOTE_CLASS, "text-xs leading-4.5")}>
              Uses this machine's checkout, git sign-in and environment. Repositories and variable
              sets aren't added.
            </p>
          </RadioGroup>
        ) : null}
      </div>
    </>
  );
}

/** Whether "Visibility" is a real choice here (an activated organization). */
export function hasVisibilityChoice(props: {
  personalWorkspace: boolean;
  canCreatePrivate: boolean;
}): boolean {
  return !props.personalWorkspace && props.canCreatePrivate;
}

export function visibilitySummary(value: "private" | "workspace"): string {
  return value === "private" ? "Only me" : "Workspace";
}

export function VisibilityMenuBody(props: {
  leading?: ReactNode;
  presentation?: MenuBodyPresentation;
  value: "private" | "workspace";
  disabled: boolean;
  onChange: (visibility: "private" | "workspace") => void;
}) {
  const presentation = props.presentation ?? "menu";
  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusCheckedRow(bodyRef, presentation);
  return (
    <>
      <ComposerMenuHeader title="Who can see this chat" leading={props.leading} />
      <div ref={bodyRef} className="min-h-0 overflow-y-auto overscroll-contain pb-1">
        <RadioGroup presentation={presentation} label="Who can see this chat" value={props.value}>
          <RadioRow
            value="workspace"
            disabled={props.disabled}
            icon={<UsersIcon />}
            label="Workspace"
            meta="People in this workspace"
            onSelect={() => props.onChange("workspace")}
          />
          <RadioRow
            value="private"
            disabled={props.disabled}
            icon={<LockIcon />}
            label="Only me"
            meta="Just you"
            onSelect={() => props.onChange("private")}
          />
        </RadioGroup>
      </div>
    </>
  );
}
