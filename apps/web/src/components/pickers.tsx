import { CheckIcon, ChevronDownIcon, PlugIcon } from "lucide-react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { McpServerOption } from "@/lib/session-tools";
import { cn } from "@/lib/utils";

export {
  ModelPolicyPicker as ModelPicker,
  ModelPolicyPickerMenu as ModelPickerMenu,
  PickerAnimatedPage,
  PickerBackHeader,
  PickerNavRow,
} from "@opengeni/react";
export type { ModelPolicyPickerProps as ModelPickerProps, PickerModelRow } from "@opengeni/react";

function pillClass(active: boolean, className?: string): string {
  return cn(
    "h-8 max-w-[12rem] gap-1.5 rounded-full border px-2.5 text-xs",
    active
      ? "border-brand/35 bg-brand/10 text-fg"
      : "border-transparent text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg",
    className,
  );
}

export type SessionToolSelection = {
  mcpServerIds: Set<string>;
  firstPartyToolIds: Set<FirstPartyMcpToolName>;
};

export function visibleSessionToolSelection(
  selection: SessionToolSelection,
  servers: ReadonlyArray<Pick<McpServerOption, "id">>,
  firstPartyTools: ReadonlyArray<Pick<{ id: FirstPartyMcpToolName }, "id">>,
): SessionToolSelection {
  const visibleMcpIds = new Set(servers.map((server) => server.id));
  const visibleFirstPartyIds = new Set(firstPartyTools.map((tool) => tool.id));
  return {
    mcpServerIds: new Set([...selection.mcpServerIds].filter((id) => visibleMcpIds.has(id))),
    firstPartyToolIds: new Set(
      [...selection.firstPartyToolIds].filter((id) => visibleFirstPartyIds.has(id)),
    ),
  };
}

/** Shared tools list body — used by the bar picker and the mobile “+” drill-in. */
export function SessionToolsMenuBody(props: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  onChange: (selection: SessionToolSelection) => void;
  /** Optional leading chrome (e.g. Back) rendered beside the title. */
  leading?: ReactNode;
}) {
  const visibleSelection = visibleSessionToolSelection(
    props.selection,
    props.servers,
    props.firstPartyTools,
  );
  const total = props.servers.length + props.firstPartyTools.length;
  const selectedMcpIds = visibleSelection.mcpServerIds;
  const selectedFirstPartyIds = visibleSelection.firstPartyToolIds;
  const selected = selectedMcpIds.size + selectedFirstPartyIds.size;

  const toggleMcp = (id: string) => {
    const next: SessionToolSelection = {
      mcpServerIds: selectedMcpIds,
      firstPartyToolIds: selectedFirstPartyIds,
    };
    if (next.mcpServerIds.has(id)) next.mcpServerIds.delete(id);
    else next.mcpServerIds.add(id);
    props.onChange(next);
  };
  const toggleFirstParty = (id: FirstPartyMcpToolName) => {
    const next: SessionToolSelection = {
      mcpServerIds: selectedMcpIds,
      firstPartyToolIds: selectedFirstPartyIds,
    };
    if (next.firstPartyToolIds.has(id)) next.firstPartyToolIds.delete(id);
    else next.firstPartyToolIds.add(id);
    props.onChange(next);
  };
  const setAll = (enabled: boolean) =>
    props.onChange({
      mcpServerIds: new Set(enabled ? props.servers.map((server) => server.id) : []),
      firstPartyToolIds: new Set(enabled ? props.firstPartyTools.map((tool) => tool.id) : []),
    });

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-2 px-2 pt-1 pb-1.5">
        <div className="flex min-w-0 items-start gap-1">
          {props.leading}
          <div className="min-w-0">
            <DropdownMenuLabel className="p-0 text-sm font-medium text-fg">
              Session tools
            </DropdownMenuLabel>
            <p className="mt-0.5 text-xs text-fg-subtle">
              Changes apply to future work in this session.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg"
          onClick={(event) => {
            event.preventDefault();
            setAll(selected !== total);
          }}
        >
          {selected === total ? "Clear all" : "Enable all"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {props.servers.length > 0 ? (
          <>
            <DropdownMenuLabel className="px-2 pt-2 pb-1 text-xs font-normal text-fg-subtle">
              Connected tools
            </DropdownMenuLabel>
            {props.servers.map((server) => (
              <SessionToolPickerItem
                key={`mcp:${server.id}`}
                id={server.id}
                name={server.name}
                selected={props.selection.mcpServerIds.has(server.id)}
                onToggle={() => toggleMcp(server.id)}
              />
            ))}
          </>
        ) : null}
        <DropdownMenuLabel className="px-2 pt-2 pb-1 text-xs font-normal text-fg-subtle">
          OpenGeni
        </DropdownMenuLabel>
        {props.firstPartyTools.map((tool) => (
          <SessionToolPickerItem
            key={`opengeni:${tool.id}`}
            id={tool.id}
            name={tool.name}
            selected={props.selection.firstPartyToolIds.has(tool.id)}
            onToggle={() => toggleFirstParty(tool.id)}
          />
        ))}
      </div>
    </>
  );
}

export function SessionToolPicker(props: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  disabled?: boolean;
  saving?: boolean;
  /** Prefer `bottom` on home/new-chat; `top` when composer is docked at bottom. */
  menuSide?: "top" | "bottom";
  /** Extra classes on the bar trigger (e.g. `max-sm:hidden` when opened from +). */
  triggerClassName?: string;
  onChange: (selection: SessionToolSelection) => void;
}) {
  const visibleSelection = visibleSessionToolSelection(
    props.selection,
    props.servers,
    props.firstPartyTools,
  );
  const total = props.servers.length + props.firstPartyTools.length;
  const selected =
    visibleSelection.mcpServerIds.size + visibleSelection.firstPartyToolIds.size;
  const menuSide = props.menuSide ?? "bottom";
  if (total === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={props.disabled}
          aria-label={props.saving ? "Saving tools" : "Session tools"}
          className={pillClass(selected > 0, props.triggerClassName)}
        >
          <PlugIcon className="size-3.5" />
          <span className="truncate">
            {props.saving
              ? "Saving tools"
              : selected === total
                ? "Tools · All"
                : `Tools · ${selected}/${total}`}
          </span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={menuSide}
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-80 flex-col overflow-hidden rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <SessionToolsMenuBody
          servers={props.servers}
          firstPartyTools={props.firstPartyTools}
          selection={props.selection}
          onChange={props.onChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionToolPickerItem(props: {
  id: string;
  name: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <DropdownMenuItem
      title={props.id}
      onSelect={(event) => {
        event.preventDefault();
        props.onToggle();
      }}
      className="min-h-9 cursor-pointer rounded-md px-2 py-1.5 text-sm"
    >
      <span className="min-w-0 flex-1 truncate">{props.name}</span>
      <span
        className={cn(
          "ml-2 flex size-4 shrink-0 items-center justify-center rounded border",
          props.selected ? "border-brand bg-brand text-white" : "border-border bg-surface",
        )}
        aria-hidden
      >
        {props.selected ? <CheckIcon className="size-3" /> : null}
      </span>
    </DropdownMenuItem>
  );
}
