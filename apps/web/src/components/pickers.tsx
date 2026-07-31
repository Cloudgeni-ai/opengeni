import { CheckIcon, ChevronDownIcon, PlugIcon } from "lucide-react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  advancedSourceSummary,
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  findPickerRow,
  groupPickerRowsByBillingClass,
  labelLatencyMode,
  payerSummaryForModel,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "@/lib/model-policy";
import { isCodexProductModel } from "@/lib/session-model";
import { labelEffort, type IntelligenceEffort, type McpServerOption } from "@/lib/session-tools";
import { cn } from "@/lib/utils";

export type { PickerModelRow };

function selectedRowLabel(rows: PickerModelRow[], selectedId: string): string {
  return findPickerRow(rows, selectedId)?.label ?? selectedId;
}

function isCodexPickerRow(row: PickerModelRow): boolean {
  return isCodexProductModel(row.id) || row.provider === "codex-subscription";
}

/** Keep rows visible; tighten selectable + reason for remote_v2. */
function applyCodexOnly(rows: PickerModelRow[], codexOnly: boolean): PickerModelRow[] {
  if (!codexOnly) return rows;
  return rows.map((row) => {
    if (isCodexPickerRow(row)) return row;
    return {
      ...row,
      selectable: false,
      unavailableReason: row.unavailableReason ?? "Codex-only session",
    };
  });
}

export function ModelPicker(props: {
  rows: PickerModelRow[];
  model: string;
  effort: IntelligenceEffort;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  /** remote_v2: non-Codex stay listed, not selectable */
  codexOnly?: boolean;
  onModelChange: (value: string) => void;
  onEffortChange: (value: IntelligenceEffort) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const rows = useMemo(
    () => applyCodexOnly(props.rows, props.codexOnly === true),
    [props.rows, props.codexOnly],
  );
  const groups = useMemo(() => groupPickerRowsByBillingClass(rows), [rows]);
  const selectedRow = findPickerRow(rows, props.model);
  const effortOptions = selectedRow
    ? effortOptionsForModel(selectedRow.catalog)
    : (["low"] as IntelligenceEffort[]);
  const latencyModes = selectedRow ? runnableLatencyModesForModel(selectedRow.catalog) : [];
  // Catalog advertises non-default latency modes; selection is not wired yet,
  // so surface as read-only context — never as disabled fake menu items.
  const speedSummary =
    latencyModes.length > 1 || latencyModes.some((mode) => mode !== "standard")
      ? latencyModes.map(labelLatencyMode).join(" · ")
      : null;
  const routeDetails = selectedRow ? advancedSourceSummary(selectedRow.catalog) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          aria-label="Model and effort"
          className="h-8 max-w-[16rem] gap-1 rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg"
        >
          <span className="truncate font-medium text-fg">
            {props.loading && rows.length === 0
              ? "Loading models…"
              : selectedRowLabel(rows, props.model)}
          </span>
          <span>{labelEffort(props.effort)}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="max-h-[min(32rem,70vh)] w-72 overflow-y-auto rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        {props.error ? (
          <p className="px-2 py-1 text-xs text-destructive" role="alert">
            {props.error}
          </p>
        ) : null}
        {props.loading && rows.length === 0 ? (
          <p className="px-2 py-1 text-xs text-fg-subtle">Loading model catalog…</p>
        ) : null}
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-fg-subtle">
          Thinking
        </DropdownMenuLabel>
        {effortOptions.map((option) => (
          <DropdownMenuItem
            key={option}
            disabled={!selectedRow?.selectable}
            onSelect={() => props.onEffortChange(option)}
            className="h-8 cursor-pointer rounded-md px-2 text-sm"
          >
            <span>{labelEffort(option)}</span>
            {option === props.effort ? <CheckIcon className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {speedSummary ? (
          <p className="px-2 pt-1 pb-0.5 text-2xs text-fg-subtle">
            Speed (catalog): {speedSummary}
          </p>
        ) : null}
        <DropdownMenuSeparator className="my-2 bg-border" />
        <DropdownMenuLabel className="px-2 pt-0 pb-1 text-xs font-normal text-fg-subtle">
          Model
        </DropdownMenuLabel>
        {groups.length === 0 && !props.loading ? (
          <p className="px-2 py-1 text-xs text-fg-subtle">No models available.</p>
        ) : null}
        {groups.map((group) => (
          <div key={group.billingClass}>
            <DropdownMenuLabel className="px-2 pt-1 pb-0.5 text-2xs font-normal uppercase tracking-wide text-fg-subtle">
              {group.label}
            </DropdownMenuLabel>
            {group.rows.map((row) => (
              <ModelChoiceRow
                key={`${row.billingClass}:${row.id}`}
                row={row}
                selected={row.id === props.model}
                onSelect={() => {
                  props.onModelChange(row.id);
                  props.onEffortChange(coerceReasoningEffortForModel(row.catalog, props.effort));
                }}
              />
            ))}
          </div>
        ))}
        {selectedRow ? (
          <>
            <DropdownMenuSeparator className="my-2 bg-border" />
            <div className="space-y-1 px-2 pb-1 text-xs text-fg-subtle">
              <p>{payerSummaryForModel(selectedRow.catalog)}</p>
              {routeDetails ? (
                <button
                  type="button"
                  className="text-left text-fg-muted underline-offset-2 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setAdvancedOpen((open) => !open);
                  }}
                >
                  {advancedOpen ? "Hide route details" : "Show route details"}
                </button>
              ) : null}
              {advancedOpen && routeDetails ? (
                <p className="text-fg-muted">{routeDetails}</p>
              ) : null}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelChoiceRow(props: { row: PickerModelRow; selected: boolean; onSelect: () => void }) {
  const disabled = !props.row.selectable;
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => {
        if (!disabled) {
          props.onSelect();
        }
      }}
      className={cn(
        "h-auto min-h-8 cursor-pointer rounded-md px-2 py-1.5 text-sm",
        disabled && "cursor-not-allowed opacity-60",
      )}
      title={props.row.unavailableReason ?? undefined}
    >
      <span className="min-w-0 flex-1 truncate">{props.row.label}</span>
      {props.selected ? <CheckIcon className="ml-2 size-4 shrink-0" /> : null}
      {props.row.unavailableReason ? (
        <span className="ml-2 shrink-0 text-2xs text-fg-subtle">{props.row.unavailableReason}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

function pillClass(active: boolean): string {
  return cn(
    "h-8 max-w-[12rem] gap-1.5 rounded-full border px-2.5 text-xs",
    active
      ? "border-brand/35 bg-brand/10 text-fg"
      : "border-transparent text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg",
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

export function SessionToolPicker(props: {
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  disabled?: boolean;
  saving?: boolean;
  onChange: (selection: SessionToolSelection) => void;
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
  if (total === 0) return null;

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={props.disabled}
          aria-label={props.saving ? "Saving tools" : "Session tools"}
          className={pillClass(selected > 0)}
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
        side="top"
        sideOffset={8}
        className="max-h-[min(32rem,70vh)] w-80 overflow-y-auto rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
          <div>
            <DropdownMenuLabel className="p-0 text-sm font-medium text-fg">
              Session tools
            </DropdownMenuLabel>
            <p className="mt-0.5 text-xs text-fg-subtle">
              Changes apply to future work in this session.
            </p>
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
