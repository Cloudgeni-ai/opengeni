// The compact "Run on" control in the session header: shows the session's
// currently-active machine and, on click, opens a dropdown to live-swap the
// session's active sandbox to any online machine (the session's own box + the
// enrolled selfhosted machines). Backed by `useMachines({ sessionId })`, whose
// `attach(sandboxId)` performs the swap and re-polls the pointer.
//
// Degrades gracefully: when selfhosted is disabled the machines API 404s →
// `fleet.machines` is empty and this falls back to a static "Run on: Cloud
// sandbox" label with no actionable dropdown.
import { useMachines, type MachineView } from "@opengeni/react/machines";
import { CheckIcon, ChevronDownIcon, Loader2Icon, ServerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";

const CLOUD_SANDBOX_LABEL = "Cloud sandbox";

/** Whether a machine can be a swap target right now (the active one always can,
 *  since selecting it is a harmless no-op; otherwise it must be compute-selectable). */
function isSelectable(machine: MachineView): boolean {
  return machine.active || isMachineComputeSelectable(machine.state);
}

export function SessionSandboxSwitcher({
  workspaceId: _workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  const fleet = useMachines({ sessionId, pollIntervalMs: 5000 });
  const machines = fleet.machines;
  const activeMachine = machines.find((machine) => machine.active) ?? null;
  const activeName = activeMachine?.name ?? CLOUD_SANDBOX_LABEL;

  // No machines to choose between (selfhosted off, or only the session box and
  // it is already active): render a static, non-interactive label.
  const hasChoices = machines.length > 1 && fleet.canAttach;
  if (!hasChoices) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 truncate text-2xs text-fg-subtle">
        <ServerIcon className="size-3 shrink-0" />
        <span className="shrink-0">on</span>
        <span className="truncate text-fg-muted">{activeName}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 max-w-[12rem] gap-1 rounded-full border border-transparent px-1.5 text-2xs text-fg-subtle hover:border-border hover:bg-surface-2 hover:text-fg"
        >
          <ServerIcon className="size-3 shrink-0" />
          {/* Natural-language "on {target}" — semantic without the colon-label
              grammar; "Run on" remains the dropdown menu's label. */}
          <span className="shrink-0">on</span>
          <span className="truncate text-fg-muted">{activeName}</span>
          {fleet.attaching ? (
            <Loader2Icon className="size-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-60 rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-fg-subtle">
          Run on
        </DropdownMenuLabel>
        {machines.map((machine) => {
          const selectable = isSelectable(machine);
          const swapping = fleet.attachingSandboxId === machine.sandboxId;
          return (
            <DropdownMenuItem
              key={machine.sandboxId}
              disabled={!selectable || fleet.attaching}
              // Selecting the active one is a no-op; the hook collapses it.
              onSelect={(event) => {
                event.preventDefault();
                if (machine.active || !selectable) {
                  return;
                }
                void fleet.attach(machine.sandboxId);
              }}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
            >
              <ServerIcon className="size-3.5 shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate">{machine.name}</span>
              {machine.state !== "online" && !machine.active ? (
                <span className="shrink-0 text-2xs text-fg-subtle">{machine.state}</span>
              ) : null}
              {swapping ? (
                <Loader2Icon className="ml-1 size-4 shrink-0 animate-spin" />
              ) : machine.active ? (
                <CheckIcon className="ml-1 size-4 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {fleet.mutationError ? (
          <p className="px-2 pt-1 text-2xs text-danger">
            Swap failed: {fleet.mutationError.message}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
