import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { ChevronLeftIcon, PaperclipIcon, PlugIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import {
  SessionToolsMenuBody,
  visibleSessionToolSelection,
  type SessionToolSelection,
} from "@/components/pickers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { McpServerOption } from "@/lib/session-tools";

type Panel = "root" | "tools";

/**
 * Mobile-only “+” overflow. Attach + tools live here so the bar stays one row.
 * Tools drill in inside this same menu (anchored to +) — never a second floating
 * menu tied to a hidden desktop trigger.
 */
export function ComposerMobilePlus(props: {
  disabled?: boolean;
  fileUploadsEnabled: boolean;
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  toolsDisabled?: boolean;
  onToolSelectionChange: (selection: SessionToolSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("root");
  const toolsTotal = props.servers.length + props.firstPartyTools.length;
  const visible = visibleSessionToolSelection(
    props.selection,
    props.servers,
    props.firstPartyTools,
  );
  const toolsSelected = visible.mcpServerIds.size + visible.firstPartyToolIds.size;
  const toolsAvailable = toolsTotal > 0;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPanel("root");
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={props.disabled}
          aria-label="More composer actions"
          className="size-8 shrink-0 rounded-full border border-border text-fg-muted hover:text-fg sm:hidden pointer-coarse:size-9"
        >
          <PlusIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className={
          panel === "tools"
            ? "flex w-[min(20rem,calc(100vw-1.5rem))] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl p-2"
            : "min-w-52 rounded-xl"
        }
      >
        {panel === "root" ? (
          <>
            {props.fileUploadsEnabled ? (
              <DropdownMenuItem
                className="pointer-coarse:min-h-11"
                disabled={props.disabled}
                onSelect={(event) => {
                  event.preventDefault();
                  setOpen(false);
                  const root = document.querySelector<HTMLElement>("[data-og-composer-id]");
                  root?.querySelector<HTMLInputElement>("[data-og-composer-attach]")?.click();
                }}
              >
                <PaperclipIcon className="size-4" />
                Add photos & files
              </DropdownMenuItem>
            ) : null}
            {toolsAvailable ? (
              <DropdownMenuItem
                className="pointer-coarse:min-h-11"
                disabled={props.disabled || props.toolsDisabled}
                onSelect={(event) => {
                  event.preventDefault();
                  setPanel("tools");
                }}
              >
                <PlugIcon className="size-4" />
                Tools
                <span className="ml-auto text-2xs text-fg-subtle">
                  {toolsSelected}/{toolsTotal}
                </span>
              </DropdownMenuItem>
            ) : null}
          </>
        ) : (
          <SessionToolsMenuBody
            servers={props.servers}
            firstPartyTools={props.firstPartyTools}
            selection={props.selection}
            onChange={props.onToolSelectionChange}
            leading={
              <button
                type="button"
                aria-label="Back"
                className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
                onClick={(event) => {
                  event.preventDefault();
                  setPanel("root");
                }}
              >
                <ChevronLeftIcon className="size-4" />
              </button>
            }
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
