import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlugIcon,
  ZapIcon,
} from "lucide-react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { BillingClassMark } from "@/components/billing-class-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  findPickerRow,
  groupPickerRowsByBillingClass,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "@/lib/model-policy";
import { displayModel } from "@/lib/format";
import { isCodexProductModel } from "@/lib/session-model";
import { labelEffort, type IntelligenceEffort, type McpServerOption } from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { LatencyMode } from "@/types";

export type { PickerModelRow };

type PickerBillingClass = PickerModelRow["billingClass"];
type NavLevel = "providers" | "models" | "thinking";

const BILLING_CLASS_HINT: Record<PickerBillingClass, string> = {
  opengeni_credits: "Will use credits",
  codex_subscription: "ChatGPT / Codex plan",
  byok: "Your API key",
};

const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;

type PickerNavState = {
  level: NavLevel;
  rail: PickerBillingClass | null;
  modelId: string | null;
};

function selectedRowLabel(rows: PickerModelRow[], selectedId: string): string {
  return findPickerRow(rows, selectedId)?.label ?? displayModel(selectedId);
}

/** Rail mark from catalog truth, else the durable id prefix — never a fake row. */
function billingClassForSelection(
  rows: PickerModelRow[],
  selectedId: string,
): PickerBillingClass {
  return (
    findPickerRow(rows, selectedId)?.billingClass ??
    (isCodexProductModel(selectedId) ? "codex_subscription" : "opengeni_credits")
  );
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

function defaultNavState(rows: PickerModelRow[], modelId: string): PickerNavState {
  const selected = findPickerRow(rows, modelId);
  if (!selected) return { level: "providers", rail: null, modelId: null };
  // Land on the selected model's Thinking page (correct leaf for the current choice).
  return {
    level: "thinking",
    rail: selected.billingClass,
    modelId: selected.id,
  };
}

type NavUpdater = PickerNavState | ((prev: PickerNavState) => PickerNavState);

/**
 * In-memory nav only: survives close/reopen of the menu while mounted.
 * Refresh / new mount / session switch → back to the current selection leaf.
 * Never sessionStorage / server.
 */
function usePickerNavState(
  sessionKey: string | undefined,
  rows: PickerModelRow[],
  model: string,
): [PickerNavState, (next: NavUpdater) => void] {
  const [state, setState] = useState<PickerNavState>(() => defaultNavState(rows, model));

  useEffect(() => {
    setState(defaultNavState(rows, model));
  }, [sessionKey]); // session switch / fresh mount scope

  return [state, setState];
}

function NavRow(props: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2",
        props.active && "text-fg",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {props.icon}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            props.active ? "font-medium text-fg" : "text-fg",
          )}
        >
          {props.label}
        </span>
        {props.hint ? (
          <span className="mt-0.5 block truncate text-2xs text-fg-subtle">{props.hint}</span>
        ) : null}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-fg-subtle" />
    </button>
  );
}

function BackHeader(props: {
  label: string;
  icon?: ReactNode;
  onBack: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center gap-0.5 border-b border-border/70 px-0.5 pb-1.5">
      <button
        type="button"
        onClick={props.onBack}
        data-testid="model-picker-back"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2"
      >
        <ChevronLeftIcon className="size-3.5 shrink-0 text-fg-subtle" />
        {props.icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {props.label}
        </span>
      </button>
      {props.trailing ? <div className="relative z-10 shrink-0">{props.trailing}</div> : null}
    </div>
  );
}

export type ModelPickerProps = {
  rows: PickerModelRow[];
  model: string;
  effort: IntelligenceEffort;
  latencyMode: LatencyMode;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  /** remote_v2: non-Codex stay listed, not selectable */
  codexOnly?: boolean;
  /** When this changes (e.g. session id), nav resets to the current selection leaf. */
  sessionKey?: string;
  /**
   * Preferred menu side. Home/new-chat (composer mid-page): `bottom`.
   * In-session (composer docked at bottom): `top`.
   */
  menuSide?: "top" | "bottom";
  onModelChange: (value: string) => void;
  onEffortChange: (value: IntelligenceEffort) => void;
  onLatencyModeChange: (value: LatencyMode) => void;
};

/**
 * Left→right drill: providers → models → thinking.
 * Same footprint; page slides; only Thinking leaves show a selection check.
 * Exported for unit tests.
 */
export function ModelPickerMenu(
  props: ModelPickerProps & {
    nav?: PickerNavState;
    onNavChange?: (next: NavUpdater) => void;
  },
) {
  const reduceMotion = useReducedMotion();
  const rows = useMemo(
    () => applyCodexOnly(props.rows, props.codexOnly === true),
    [props.rows, props.codexOnly],
  );
  const groups = useMemo(() => groupPickerRowsByBillingClass(rows), [rows]);
  const [localNav, setLocalNav] = usePickerNavState(
    props.nav !== undefined ? undefined : props.sessionKey,
    rows,
    props.model,
  );
  const nav = props.nav ?? localNav;
  const setNav = props.onNavChange ?? setLocalNav;
  const [direction, setDirection] = useState(1);

  const activeGroup =
    nav.rail === null ? undefined : groups.find((group) => group.billingClass === nav.rail);
  const focusModel =
    nav.modelId === null ? undefined : findPickerRow(rows, nav.modelId);
  const selectedRow = findPickerRow(rows, props.model);

  useEffect(() => {
    // Never coerce latency off a loading catalog or an ensure-selected stub —
    // that briefly cleared Fast / switched rails before real capabilities arrived.
    if (props.loading || !selectedRow?.selectable) {
      return;
    }
    const selectedFast = runnableLatencyModesForModel(selectedRow.catalog).includes("fast");
    if (!selectedFast && props.latencyMode !== "standard") {
      props.onLatencyModeChange("standard");
    }
  }, [props.latencyMode, props.loading, props.onLatencyModeChange, selectedRow]);

  const go = (next: PickerNavState, dir: 1 | -1) => {
    setDirection(dir);
    setNav(next);
  };

  const selectEffort = (row: PickerModelRow, option: IntelligenceEffort) => {
    if (!row.selectable) return;
    if (row.id !== props.model) {
      props.onModelChange(row.id);
    }
    props.onEffortChange(coerceReasoningEffortForModel(row.catalog, option));
  };

  const pageKey =
    nav.level === "providers"
      ? "providers"
      : nav.level === "models"
        ? `models:${nav.rail ?? ""}`
        : `thinking:${nav.modelId ?? ""}`;

  let body: ReactNode = null;
  if (props.loading && rows.length === 0) {
    body = <p className="px-2 py-3 text-xs text-fg-subtle">Loading model catalog…</p>;
  } else if (groups.length === 0) {
    body = <p className="px-2 py-3 text-xs text-fg-subtle">No models available.</p>;
  } else if (nav.level === "providers") {
    body = (
      <div className="flex flex-col gap-0.5" data-testid="model-picker-providers">
        {groups.map((group) => (
          <NavRow
            key={group.billingClass}
            label={group.label}
            hint={BILLING_CLASS_HINT[group.billingClass]}
            icon={<BillingClassMark billingClass={group.billingClass} />}
            active={selectedRow?.billingClass === group.billingClass}
            testId={`model-picker-rail-${group.billingClass}`}
            onClick={() =>
              go({ level: "models", rail: group.billingClass, modelId: null }, 1)
            }
          />
        ))}
      </div>
    );
  } else if (nav.level === "models" && activeGroup) {
    body = (
      <div data-testid="model-picker-models">
        <BackHeader
          label={activeGroup.label}
          icon={<BillingClassMark billingClass={activeGroup.billingClass} />}
          onBack={() =>
            go({ level: "providers", rail: null, modelId: null }, -1)
          }
        />
        <div className="flex flex-col gap-0.5">
          {activeGroup.rows.map((row) => (
            <NavRow
              key={`${row.billingClass}:${row.id}`}
              label={row.label}
              hint={row.unavailableReason ?? undefined}
              disabled={!row.selectable}
              title={row.unavailableReason ?? undefined}
              active={row.id === props.model}
              testId={`model-picker-choice-${row.id}`}
              onClick={() => {
                if (!row.selectable) return;
                go(
                  { level: "thinking", rail: row.billingClass, modelId: row.id },
                  1,
                );
              }}
            />
          ))}
        </div>
      </div>
    );
  } else if (nav.level === "thinking" && focusModel) {
    const isActiveModel = focusModel.id === props.model;
    const fastRunnable = runnableLatencyModesForModel(focusModel.catalog).includes("fast");
    body = (
      <div data-testid="model-picker-reasoning">
        <BackHeader
          label={focusModel.label}
          icon={<BillingClassMark billingClass={focusModel.billingClass} />}
          onBack={() =>
            go(
              {
                level: "models",
                rail: focusModel.billingClass,
                modelId: null,
              },
              -1,
            )
          }
          trailing={
            fastRunnable ? (
              <button
                type="button"
                disabled={!focusModel.selectable}
                aria-pressed={isActiveModel && props.latencyMode === "fast"}
                aria-label={
                  isActiveModel && props.latencyMode === "fast"
                    ? "Disable Fast"
                    : "Enable Fast"
                }
                title={
                  isActiveModel && props.latencyMode === "fast"
                    ? "Fast on · 2× rate"
                    : "Fast · 2× rate"
                }
                data-testid="model-picker-fast"
                onClick={() => {
                  if (!isActiveModel) {
                    props.onModelChange(focusModel.id);
                    props.onEffortChange(
                      coerceReasoningEffortForModel(focusModel.catalog, props.effort),
                    );
                  }
                  props.onLatencyModeChange(
                    isActiveModel && props.latencyMode === "fast" ? "standard" : "fast",
                  );
                }}
                className={cn(
                  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50",
                  isActiveModel && props.latencyMode === "fast"
                    ? "text-fg"
                    : "text-fg-subtle",
                )}
              >
                <ZapIcon
                  className={cn(
                    "size-3.5",
                    isActiveModel && props.latencyMode === "fast" && "fill-current",
                  )}
                />
              </button>
            ) : null
          }
        />
        <p className="px-2.5 pt-1 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
          Thinking
        </p>
        <div className="flex flex-col gap-0.5">
          {effortOptionsForModel(focusModel.catalog).map((option) => {
            const selected = isActiveModel && option === props.effort;
            return (
              <button
                key={option}
                type="button"
                disabled={!focusModel.selectable}
                onClick={() => selectEffort(focusModel, option)}
                className={cn(
                  "flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-sm transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50",
                  selected && "bg-surface-2 text-fg",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{labelEffort(option)}</span>
                {selected ? (
                  <CheckIcon
                    className="ml-auto size-3.5 shrink-0"
                    data-testid="model-picker-effort-check"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  } else {
    // Recover from a stale persisted path.
    body = (
      <div className="flex flex-col gap-0.5" data-testid="model-picker-providers">
        {groups.map((group) => (
          <NavRow
            key={group.billingClass}
            label={group.label}
            hint={BILLING_CLASS_HINT[group.billingClass]}
            icon={<BillingClassMark billingClass={group.billingClass} />}
            testId={`model-picker-rail-${group.billingClass}`}
            onClick={() =>
              go({ level: "models", rail: group.billingClass, modelId: null }, 1)
            }
          />
        ))}
      </div>
    );
  }

  // Enter-only slide: previous page unmounts immediately so headers/rows never
  // ghost-click during an exit animation, and the clicked control stays put.
  return (
    <div data-testid="model-picker-menu" className="relative overflow-hidden">
      {props.error ? (
        <p className="px-2 py-1 text-xs text-destructive" role="alert">
          {props.error}
        </p>
      ) : null}
      <motion.div
        key={pageKey}
        initial={reduceMotion ? false : { x: direction * 14, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: SLIDE_EASE }}
        className="w-full"
      >
        {body}
      </motion.div>
    </div>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () => applyCodexOnly(props.rows, props.codexOnly === true),
    [props.rows, props.codexOnly],
  );
  const [nav, setNav] = usePickerNavState(props.sessionKey, rows, props.model);
  const selectedRow = findPickerRow(rows, props.model);
  const fastActive = props.latencyMode === "fast";
  const menuSide = props.menuSide ?? "bottom";
  // Hide speculative defaults (wrong rail / Fast wipe) until catalog + draft settle.
  if (props.loading) {
    return (
      <Skeleton
        className="h-8 w-40 shrink-0 rounded-full"
        aria-label="Loading model and effort"
        data-testid="model-picker-loading"
      />
    );
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          aria-label="Model and effort"
          className="h-8 max-w-[16rem] gap-1 rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg"
        >
          <BillingClassMark
            billingClass={billingClassForSelection(rows, props.model)}
            className="size-3.5 text-fg"
          />
          <span className="truncate font-medium text-fg">{selectedRowLabel(rows, props.model)}</span>
          <span>{labelEffort(props.effort)}</span>
          {fastActive ? (
            <ZapIcon
              className="size-3.5 shrink-0 text-fg"
              aria-label="Fast"
              data-testid="model-picker-fast-icon"
            />
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={menuSide}
        sideOffset={8}
        collisionPadding={12}
        className="flex w-72 max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl border-border bg-surface p-1.5 shadow-xl"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ModelPickerMenu {...props} nav={nav} onNavChange={setNav} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
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
  /** Prefer `bottom` on home/new-chat; `top` when composer is docked at bottom. */
  menuSide?: "top" | "bottom";
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
  const menuSide = props.menuSide ?? "bottom";
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
        side={menuSide}
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-80 flex-col overflow-hidden rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between px-2 pt-1 pb-1.5">
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
