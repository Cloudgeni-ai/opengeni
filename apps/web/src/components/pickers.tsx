import { CheckIcon, ChevronDownIcon, PlugIcon } from "lucide-react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isCodexProductModel } from "@/lib/session-model";
import {
  effortOptionsFor,
  labelEffort,
  type IntelligenceEffort,
  type McpServerOption,
} from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { ClientConfig, ClientModel } from "@/types";

/**
 * One row in the model dropdown: the id sent to the host plus the display label
 * and the provider section it belongs under. Derived from the host-exposed
 * {@link ClientConfig.models} (provider-grouped, with labels) when present, and
 * falls back to the flat {@link ClientConfig.allowedModels} id list on older
 * hosts (no provider grouping, label === id). Always includes the currently
 * selected model so a stale/curated-out choice still renders its own row.
 *
 * On remote_v2 (`codexOnly`), non-Codex rows stay visible but disabled — same
 * chrome as a normal session, just not selectable.
 */
type ModelChoice = {
  id: string;
  label: string;
  providerLabel: string | null;
  disabled: boolean;
};

function isCodexModelChoice(id: string, provider?: string | null): boolean {
  return isCodexProductModel(id) || provider === "codex-subscription";
}

/** Catalog / id label — never invent a shouty short name. */
function modelChoiceLabel(id: string, catalogLabel?: string): string {
  if (catalogLabel && catalogLabel.length > 0) return catalogLabel;
  return isCodexProductModel(id) ? id.slice("codex/".length) : id;
}

function modelChoices(
  config: ClientConfig | null,
  selected: string,
  extraModels: ClientModel[] = [],
  codexOnly = false,
): ModelChoice[] {
  // extraModels are workspace-scoped (e.g. a connected Codex subscription's models)
  // appended to the host's deployment list; provider grouping keeps them distinct.
  const rich = [...(config?.models ?? []), ...extraModels];
  const choices: ModelChoice[] =
    rich.length > 0
      ? rich.map((model) => ({
          id: model.id,
          label: modelChoiceLabel(model.id, model.label),
          providerLabel: model.providerLabel,
          disabled: codexOnly && !isCodexModelChoice(model.id, model.provider),
        }))
      : (config?.allowedModels ?? [selected]).map((id) => ({
          id,
          label: modelChoiceLabel(id),
          providerLabel: null,
          disabled: codexOnly && !isCodexModelChoice(id),
        }));
  // Guarantee the active selection is always offered, even if the host has since
  // curated it out of the exposed list (mirrors the old `[props.model]` fallback).
  if (!choices.some((choice) => choice.id === selected)) {
    choices.unshift({
      id: selected,
      label: modelChoiceLabel(selected),
      providerLabel: null,
      disabled: codexOnly && !isCodexModelChoice(selected),
    });
  }
  return choices;
}

/** Trigger label for the active model: its display label from the exposed list. */
function selectedModelLabel(choices: ModelChoice[], selected: string): string {
  return choices.find((choice) => choice.id === selected)?.label ?? modelChoiceLabel(selected);
}

export function ModelPicker(props: {
  config: ClientConfig | null;
  model: string;
  effort: IntelligenceEffort;
  disabled?: boolean;
  extraModels?: ClientModel[];
  /**
   * When true (remote_v2 sessions), non-Codex models remain listed but cannot
   * be selected. Same picker chrome as a normal session.
   */
  codexOnly?: boolean;
  onModelChange: (value: string) => void;
  onEffortChange: (value: IntelligenceEffort) => void;
}) {
  // Host-curated effort allow-list, canonically ordered, full enum — mirrors how
  // the model picker is driven by config.allowedModels (no lossy UI filter).
  const effortOptions = effortOptionsFor(props.config);
  const choices = modelChoices(
    props.config,
    props.model,
    props.extraModels ?? [],
    props.codexOnly === true,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          aria-label="Model and effort"
          className="h-8 max-w-[14rem] gap-1 rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg"
        >
          <span className="truncate font-medium text-fg">
            {selectedModelLabel(choices, props.model)}
          </span>
          <span>{labelEffort(props.effort)}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-56 rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-fg-subtle">
          Effort
        </DropdownMenuLabel>
        {effortOptions.map((option) => (
          <DropdownMenuItem
            key={option}
            onSelect={() => props.onEffortChange(option)}
            className="h-8 cursor-pointer rounded-md px-2 text-sm"
          >
            <span>{labelEffort(option)}</span>
            {option === props.effort ? <CheckIcon className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-2 bg-border" />
        <DropdownMenuLabel className="px-2 pt-0 pb-1 text-xs font-normal text-fg-subtle">
          Model
        </DropdownMenuLabel>
        {choices.map((choice, index) => (
          <ModelChoiceRow
            key={choice.id}
            choice={choice}
            // Repeat a provider heading only when it changes from the row above,
            // so multi-provider lists read as grouped sections; single-provider
            // (and the flat allowedModels fallback) shows no heading at all.
            showProviderLabel={
              choice.providerLabel !== null &&
              choice.providerLabel !== choices[index - 1]?.providerLabel
            }
            selected={choice.id === props.model}
            onSelect={() => {
              if (choice.disabled) return;
              props.onModelChange(choice.id);
            }}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelChoiceRow(props: {
  choice: ModelChoice;
  showProviderLabel: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <>
      {props.showProviderLabel ? (
        <DropdownMenuLabel className="px-2 pt-1 pb-0.5 text-2xs font-normal uppercase tracking-wide text-fg-subtle">
          {props.choice.providerLabel}
        </DropdownMenuLabel>
      ) : null}
      <DropdownMenuItem
        onSelect={props.onSelect}
        disabled={props.choice.disabled}
        className="h-8 cursor-pointer rounded-md px-2 text-sm"
      >
        <span className="truncate">{props.choice.label}</span>
        {props.selected ? <CheckIcon className="ml-auto size-4 shrink-0" /> : null}
      </DropdownMenuItem>
    </>
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
