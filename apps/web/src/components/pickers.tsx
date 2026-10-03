import { ChevronDownIcon, PlugIcon } from "lucide-react";
import { Suspense } from "react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  ModelPolicyPicker,
  ModelPolicyPickerMenu,
  type ModelPolicyPickerGroupPresentation,
  type ModelPolicyPickerProps,
} from "@opengeni/react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { McpServerOption } from "@/lib/session-tools";
import { capabilityGroupSelection, sessionCapabilityGroupsFor } from "@/lib/session-capabilities";
import { cn } from "@/lib/utils";
import { openGeniGroupPresentation } from "./billing-class-mark";

export { PickerAnimatedPage, PickerBackHeader, PickerNavRow } from "@opengeni/react";
export type { ModelPolicyPickerProps as ModelPickerProps, PickerModelRow } from "@opengeni/react";

function firstPartyGroupPresentation(
  presentation: ModelPolicyPickerGroupPresentation | undefined,
): ModelPolicyPickerGroupPresentation {
  return {
    ...presentation,
    opengeni_credits: {
      ...openGeniGroupPresentation.opengeni_credits,
      ...presentation?.opengeni_credits,
      label:
        presentation?.opengeni_credits?.label ?? openGeniGroupPresentation.opengeni_credits?.label,
      icon:
        presentation?.opengeni_credits?.icon === undefined
          ? openGeniGroupPresentation.opengeni_credits?.icon
          : presentation.opengeni_credits.icon,
    },
  };
}

export function ModelPicker(props: ModelPolicyPickerProps) {
  return (
    <ModelPolicyPicker
      {...props}
      groupPresentation={firstPartyGroupPresentation(props.groupPresentation)}
    />
  );
}

export function ModelPickerMenu(props: ModelPolicyPickerProps) {
  return (
    <ModelPolicyPickerMenu
      {...props}
      groupPresentation={firstPartyGroupPresentation(props.groupPresentation)}
    />
  );
}

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

import type { SessionConnectorsMenuProps } from "@/components/session-connectors-menu-body";
import {
  COMPOSER_MENU_PANEL_CLASS,
  ComposerMenuHeader,
  ComposerMenuRowsSkeleton,
  lazyComposerPanel,
} from "@/components/ui/composer-menu";
import { isComposerConnector } from "@/lib/session-tools";

const loadSessionConnectorsMenu = () => import("@/components/session-connectors-menu-body");

const LazySessionConnectorsMenuBody = lazyComposerPanel(() =>
  loadSessionConnectorsMenu().then((module) => module.SessionConnectorsMenuBody),
);

/** Secondary connector/account controls load only when their menu is opened. */
export function SessionToolsMenuBody(props: SessionConnectorsMenuProps) {
  // Same header and one row per known connector, so the menu keeps its size.
  const rows = Math.min(6, Math.max(1, props.servers.filter(isComposerConnector).length));
  return (
    <Suspense
      fallback={
        <>
          <ComposerMenuHeader title="Connectors" leading={props.leading} />
          <ComposerMenuRowsSkeleton rows={rows} size="tile" label="Loading connectors" />
        </>
      }
    >
      <LazySessionConnectorsMenuBody {...props} />
    </Suspense>
  );
}

export const SESSION_TOOLS_PANEL_CLASS = COMPOSER_MENU_PANEL_CLASS;

export function sessionToolSelectionSummary(props: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
}) {
  const visibleSelection = visibleSessionToolSelection(
    props.selection,
    props.servers,
    props.firstPartyTools,
  );
  const total = props.servers.length + props.firstPartyTools.length;
  const selected = visibleSelection.mcpServerIds.size + visibleSelection.firstPartyToolIds.size;
  const groups = sessionCapabilityGroupsFor(props.firstPartyTools);
  const selectedGroups = groups.filter(
    (group) => capabilityGroupSelection(group, visibleSelection.firstPartyToolIds) !== "none",
  ).length;
  const selectedCapabilities = visibleSelection.mcpServerIds.size + selectedGroups;
  return {
    total,
    selected,
    selectedCapabilities,
    label: selected === total ? "All" : String(selectedCapabilities),
  };
}

export function SessionToolPicker(props: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  disabled?: boolean;
  saving?: boolean;
  customizing?: boolean;
  onCustomizingChange?: (customizing: boolean) => void;
  /** Prefer `bottom` on home/new-chat; `top` when composer is docked at bottom. */
  menuSide?: "top" | "bottom";
  /** Extra classes on the bar trigger (e.g. `max-sm:hidden` when opened from +). */
  triggerClassName?: string;
  onChange: (selection: SessionToolSelection) => void;
}) {
  const { total, selected, label } = sessionToolSelectionSummary(props);
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
          className={cn(pillClass(selected > 0, props.triggerClassName), "session-tools-trigger")}
        >
          <PlugIcon className="size-3.5" />
          <span className="session-tools-label truncate @max-[14rem]/model-controls:hidden">
            {props.saving ? "Saving tools" : `Tools · ${label}`}
          </span>
          <ChevronDownIcon className="session-tools-chevron size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={menuSide}
        sideOffset={8}
        collisionPadding={12}
        className={SESSION_TOOLS_PANEL_CLASS}
      >
        <SessionToolsMenuBody
          servers={props.servers}
          firstPartyTools={props.firstPartyTools}
          selection={props.selection}
          customizing={props.customizing}
          onCustomizingChange={props.onCustomizingChange}
          onChange={props.onChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
