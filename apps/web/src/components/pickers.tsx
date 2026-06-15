import { CheckIcon, ChevronDownIcon, PlugIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displayModel } from "@/lib/format";
import {
  isUiReasoningEffort,
  labelEffort,
  uiReasoningEffortOrder,
  type IntelligenceEffort,
  type McpServerOption,
} from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { ClientConfig } from "@/types";

export function ModelPicker(props: {
  config: ClientConfig | null;
  model: string;
  effort: IntelligenceEffort;
  disabled?: boolean;
  onModelChange: (value: string) => void;
  onEffortChange: (value: IntelligenceEffort) => void;
}) {
  const allowedEfforts = props.config?.allowedReasoningEfforts.filter(isUiReasoningEffort) ?? uiReasoningEffortOrder;
  const effortOptions = uiReasoningEffortOrder.filter((option) => allowedEfforts.includes(option));
  const modelOptions = props.config?.allowedModels ?? [props.model];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          aria-label="Model and effort"
          className="h-8 max-w-[14rem] gap-1 rounded-full border border-transparent px-2.5 text-xs text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]"
        >
          <span className="font-medium text-[color:var(--color-fg)]">{displayModel(props.model)}</span>
          <span>{labelEffort(props.effort)}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56 rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 shadow-xl">
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">Effort</DropdownMenuLabel>
        {effortOptions.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => props.onEffortChange(option)} className="h-8 cursor-pointer rounded-md px-2 text-sm">
            <span>{labelEffort(option)}</span>
            {option === props.effort ? <CheckIcon className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-2 bg-[color:var(--color-border)]" />
        <DropdownMenuLabel className="px-2 pt-0 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">Model</DropdownMenuLabel>
        {modelOptions.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => props.onModelChange(option)} className="h-8 cursor-pointer rounded-md px-2 text-sm">
            <span>{option}</span>
            {option === props.model ? <CheckIcon className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function pillClass(active: boolean): string {
  return cn(
    "h-8 max-w-[12rem] gap-1.5 rounded-full border px-2.5 text-xs",
    active
      ? "border-[color:var(--color-brand)]/35 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]"
      : "border-transparent text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
  );
}

export function EnabledMcpToolPicker(props: {
  servers: McpServerOption[];
  selectedIds: Set<string>;
  disabled?: boolean;
  onChange: (ids: Set<string>) => void;
}) {
  if (props.servers.length === 0) {
    return null;
  }
  const selectedCount = props.selectedIds.size;
  function toggle(id: string) {
    const next = new Set(props.selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    props.onChange(next);
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={selectedCount > 0 ? "secondary" : "ghost"}
          size="sm"
          disabled={props.disabled}
          aria-label="Enabled MCP tools"
          className={pillClass(selectedCount > 0)}
        >
          <PlugIcon className="size-3.5" />
          <span className="truncate">{selectedCount > 0 ? `${selectedCount} tool${selectedCount === 1 ? "" : "s"}` : "Tools"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-72 rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 shadow-xl">
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">Enabled MCPs</DropdownMenuLabel>
        {props.servers.map((server) => (
          <DropdownMenuItem
            key={server.id}
            onSelect={(event) => {
              event.preventDefault();
              toggle(server.id);
            }}
            className="h-9 cursor-pointer rounded-md px-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            <span className="ml-2 max-w-24 truncate font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{server.id}</span>
            {props.selectedIds.has(server.id) ? <CheckIcon className="ml-2 size-4 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
