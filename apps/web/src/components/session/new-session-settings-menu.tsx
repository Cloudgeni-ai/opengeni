import type { MachineView } from "@opengeni/react/machines";
import type { NewSessionSelectionHistory, Rig } from "@opengeni/sdk";
import { BoxIcon, CheckIcon, LaptopIcon, LockIcon, ServerIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerMenuHeader } from "@/components/ui/composer-menu";
import { Input } from "@/components/ui/input";
import {
  MENU_BUTTON_CLASS,
  MENU_CHECK_CLASS,
  MENU_CHECK_SLOT_CLASS,
  MENU_LABEL_CLASS,
  MENU_META_CLASS,
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
 */

function RadioRow(props: {
  checked: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  meta?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={MENU_BUTTON_CLASS}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.meta ? <span className={MENU_META_CLASS}>{props.meta}</span> : null}
      <span className={MENU_CHECK_SLOT_CLASS}>
        {props.checked ? <CheckIcon className={MENU_CHECK_CLASS} /> : null}
      </span>
    </button>
  );
}

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

export function RunsOnMenuBody(
  props: RunsOnChoices & {
    leading?: ReactNode;
    disabled: boolean;
    onChange: (draft: SessionDraft) => void;
    onComputeChange: (draft: SessionDraft) => void;
    onRetryMachines: () => void;
  },
) {
  const { draft } = props;
  const compute = draft.compute;
  const personalRigs = props.rigs.filter((rig) => rig.scope === "user");
  const workspaceRigs = props.rigs.filter((rig) => rig.scope !== "user");
  const showWhere = props.selfhostedPrimary || props.machines.length > 0 || props.fleetLoadFailed;

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
      checked={compute.kind === "sandbox" && draft.rigId === rig.id}
      disabled={props.disabled}
      label={rig.name}
      meta={rig.activeVersion ? `v${rig.activeVersion.version}` : undefined}
      onSelect={() => props.onChange({ ...draft, rigId: rig.id })}
    />
  );

  return (
    <>
      <ComposerMenuHeader title="Runs on" leading={props.leading} />
      <div className="min-h-0 overflow-y-auto overscroll-contain pb-1">
        {showWhere ? (
          <div role="radiogroup" aria-label="Where">
            <p className={MENU_LABEL_CLASS}>Where</p>
            {props.selfhostedPrimary ? null : (
              <RadioRow
                checked={compute.kind === "sandbox"}
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
                checked={compute.kind === "machine" && compute.sandboxId === machine.sandboxId}
                disabled={props.disabled || !isMachineComputeSelectable(machine.state)}
                icon={machine.os === "macos" ? <LaptopIcon /> : <ServerIcon />}
                label={machine.name}
                meta={machineStateMeta(machine)}
                onSelect={() => selectMachine(machine)}
              />
            ))}
            {props.fleetLoadFailed ? (
              <p className={cn(MENU_NOTE_CLASS, "flex items-center justify-between gap-3")}>
                Couldn't load your connected machines.
                <button
                  type="button"
                  className="text-xs font-medium text-fg underline underline-offset-2"
                  onClick={props.onRetryMachines}
                >
                  Try again
                </button>
              </p>
            ) : props.machines.length === 0 && props.selfhostedPrimary ? (
              <p className={MENU_NOTE_CLASS}>Connect a machine to run sessions on it.</p>
            ) : null}
          </div>
        ) : null}

        {compute.kind === "sandbox" && props.rigs.length > 0 ? (
          <div role="radiogroup" aria-label="Sandbox environment">
            {showWhere ? <div className={MENU_SEPARATOR_CLASS} /> : null}
            <p className={MENU_LABEL_CLASS}>Sandbox environment</p>
            <RadioRow
              checked={draft.rigId === ""}
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
          </div>
        ) : null}

        {compute.kind === "machine" && compute.sandboxId ? (
          <div role="radiogroup" aria-label="Folder">
            <div className={MENU_SEPARATOR_CLASS} />
            <p className={MENU_LABEL_CLASS}>Folder</p>
            <RadioRow
              checked={compute.folder.kind === "root"}
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
              checked={compute.folder.kind === "path"}
              disabled={props.disabled}
              label="Custom path"
              onSelect={() =>
                props.onComputeChange({
                  ...draft,
                  compute: {
                    ...compute,
                    folder: {
                      kind: "path",
                      path: compute.folder.kind === "path" ? compute.folder.path : "",
                    },
                  },
                })
              }
            />
            {compute.folder.kind === "path" ? (
              <div className="px-2.5 pt-1 pb-1.5">
                <Input
                  value={compute.folder.path}
                  disabled={props.disabled}
                  onChange={(event) =>
                    props.onComputeChange({
                      ...draft,
                      compute: { ...compute, folder: { kind: "path", path: event.target.value } },
                    })
                  }
                  onKeyDown={(event) => event.stopPropagation()}
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
          </div>
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
  value: "private" | "workspace";
  disabled: boolean;
  onChange: (visibility: "private" | "workspace") => void;
}) {
  return (
    <>
      <ComposerMenuHeader title="Who can see this chat" leading={props.leading} />
      <div
        role="radiogroup"
        aria-label="Who can see this chat"
        className="min-h-0 overflow-y-auto overscroll-contain pb-1"
      >
        <RadioRow
          checked={props.value === "workspace"}
          disabled={props.disabled}
          icon={<UsersIcon />}
          label="Workspace"
          meta="People in this workspace"
          onSelect={() => props.onChange("workspace")}
        />
        <RadioRow
          checked={props.value === "private"}
          disabled={props.disabled}
          icon={<LockIcon />}
          label="Only me"
          meta="Just you"
          onSelect={() => props.onChange("private")}
        />
      </div>
    </>
  );
}
