import type { ClientModel, ReasoningEffort } from "@opengeni/sdk";
import { CheckIcon, SearchIcon, ZapIcon } from "lucide-react";
import { useRef, useState, type RefObject, type CSSProperties } from "react";
import { Popover } from "radix-ui";
import { cn } from "../lib/cn";
import {
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  findPickerRow,
  groupPickerRowsByBillingClass,
  labelReasoningEffort,
  payerSummaryForModel,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "../model-policy";
import {
  BillingClassMark,
  defaultModelPolicyPickerMessages,
  effectiveRows,
  PickerNavRow,
  type ModelPolicyPickerProps,
} from "./model-policy-picker";
type ClientPickerModelRow = PickerModelRow<ClientModel>;

/** Model selection stays flat; reasoning never becomes a navigation destination. */
export function ModelPolicyPickerMenu(props: ModelPolicyPickerProps) {
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  const [query, setQuery] = useState("");
  const rows = effectiveRows(props);
  const selected = findPickerRow(rows, props.model);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((row) => {
    const text =
      `${row.label} ${row.id} ${row.providerLabel} ${row.billingClassLabel} ${payerSummaryForModel(row.catalog)}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const groups = groupPickerRowsByBillingClass(filtered)
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => words.length > 0 || row.id !== selected?.id),
    }))
    .filter((group) => group.rows.length > 0);
  const choose = (row: ClientPickerModelRow) => {
    if (!row.selectable || props.disabled) return;
    if (row.id !== props.model) props.onModelChange(row.id);
    const effort = coerceReasoningEffortForModel(row.catalog, props.effort);
    // Hosts may commit the combined model/effort draft through this callback.
    props.onEffortChange(effort);
    if (
      props.latencyMode !== "standard" &&
      !runnableLatencyModesForModel(row.catalog).includes(props.latencyMode)
    ) {
      props.onLatencyModeChange("standard");
    }
    props.onOpenChange?.(false);
  };
  const modelRow = (row: ClientPickerModelRow) => (
    <PickerNavRow
      key={row.id}
      label={row.label}
      hint={`${props.messages?.billingHints?.[row.billingClass] ?? payerSummaryForModel(row.catalog)}${row.unavailableReason ? ` · ${row.unavailableReason}` : ""}`}
      disabled={props.disabled || !row.selectable}
      title={row.unavailableReason ?? undefined}
      active={row.id === props.model}
      showChevron={false}
      trailing={
        row.id === props.model ? (
          <CheckIcon className="size-3.5" aria-label={messages.selected} />
        ) : null
      }
      testId={`model-picker-choice-${row.id}`}
      onClick={() => choose(row)}
    />
  );
  return (
    <div
      data-testid="model-picker-menu"
      className="flex min-h-0 flex-col"
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLButtonElement) ||
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        )
          return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[data-testid^="model-picker-choice-"]:not(:disabled)',
          ),
        );
        const index = buttons.indexOf(event.target);
        if (index < 0) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <div className="flex items-center gap-2 border-b border-og-border px-2 py-2">
        <SearchIcon className="size-4 shrink-0 text-og-fg-subtle" aria-hidden />
        <input
          aria-label={messages.searchLabel}
          placeholder={messages.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget
                .closest('[data-testid="model-picker-menu"]')
                ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
                ?.focus();
            }
          }}
          className="h-8 min-w-0 flex-1 bg-transparent text-og-menu text-og-fg outline-hidden placeholder:text-og-fg-subtle"
        />
      </div>
      {props.error ? (
        <p className="px-2 py-2 text-og-control text-og-status-failed" role="alert">
          {props.error}
        </p>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
        data-testid="model-picker-models"
      >
        {props.loading ? (
          <p className="px-2 py-3 text-og-control text-og-fg-subtle">{messages.loading}</p>
        ) : (
          <>
            {selected && words.length === 0 ? (
              <div className="border-b border-og-border/60 pb-1 mb-1">
                <p className="px-2.5 py-1.5 text-og-control text-og-fg-subtle">
                  {messages.currentModel}
                </p>
                {modelRow(selected)}
              </div>
            ) : null}
            {groups.map((group) => (
              <section key={group.billingClass} aria-label={group.label} className="py-1">
                <div className="flex items-center gap-2 px-2.5 py-1.5 text-og-control font-medium text-og-fg-subtle">
                  <BillingClassMark billingClass={group.billingClass} aria-label="" />
                  {group.label}
                </div>
                {group.rows.map(modelRow)}
              </section>
            ))}
            {filtered.length === 0 ? (
              <p className="px-2 py-4 text-og-control text-og-fg-subtle">
                {words.length ? messages.noMatches : messages.noModels}
              </p>
            ) : null}
          </>
        )}
      </div>
      {selected ? (
        <div className="border-t border-og-border px-2 py-2">
          {selected.catalog.capabilities?.inputModalities.includes("image") === false ? (
            <p className="pb-1.5 text-og-control leading-relaxed text-og-fg-subtle">
              {messages.unsupportedAttachments}
            </p>
          ) : null}
          <ModelThinkingControls {...props} />
        </div>
      ) : null}
    </div>
  );
}

function ModelThinkingControls(props: ModelPolicyPickerProps) {
  const selected = findPickerRow(effectiveRows(props), props.model);
  if (!selected) return null;
  const efforts = effortOptionsForModel(selected.catalog);
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  const supportsFast = runnableLatencyModesForModel(selected.catalog).includes("fast");
  return (
    <div
      className="flex items-center gap-2 text-og-control text-og-fg-muted"
      data-testid="model-picker-reasoning"
    >
      <label className="flex min-h-9 items-center gap-2">
        {messages.thinking}
        <select
          aria-label={messages.thinkingEffort}
          value={coerceReasoningEffortForModel(selected.catalog, props.effort)}
          disabled={props.disabled || !selected.selectable || efforts.length < 2}
          onChange={(event) => props.onEffortChange(event.target.value as ReasoningEffort)}
          className="rounded-og-sm bg-og-surface-2 px-2 py-1.5 text-og-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
        >
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {labelReasoningEffort(effort)}
            </option>
          ))}
        </select>
      </label>
      {supportsFast && props.allowLatencyMode !== false ? (
        <button
          type="button"
          data-testid="model-picker-fast"
          disabled={props.disabled || !selected.selectable}
          aria-pressed={props.latencyMode === "fast"}
          title={`${messages.fast} · ${messages.fastRateHint}`}
          onClick={() =>
            props.onLatencyModeChange(props.latencyMode === "fast" ? "standard" : "fast")
          }
          className="ml-auto flex min-h-9 items-center gap-1.5 rounded-og-sm px-2 hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
        >
          <ZapIcon className={cn("size-3.5", props.latencyMode === "fast" && "fill-current")} />
          {messages.fast} <span className="text-og-fg-subtle">{messages.fastRateHint}</span>
        </button>
      ) : null}
    </div>
  );
}

export function ModelPolicyPickerPopover(
  props: ModelPolicyPickerProps & {
    anchor: RefObject<HTMLButtonElement | null>;
    contentId: string;
    portalStyle: CSSProperties;
  },
) {
  const outside = useRef(false);
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  return (
    <Popover.Root open onOpenChange={(open) => props.onOpenChange?.(open)}>
      <Popover.Anchor virtualRef={props.anchor} />
      <Popover.Portal>
        <Popover.Content
          id={props.contentId}
          aria-label={messages.label}
          align="start"
          side={props.menuSide ?? "bottom"}
          sideOffset={8}
          collisionPadding={12}
          onInteractOutside={(event) => {
            if (props.anchor.current?.contains(event.target as Node)) event.preventDefault();
            else outside.current = true;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!outside.current) props.anchor.current?.focus();
          }}
          className={cn(
            "og-root og-model-policy-menu z-50 flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[22rem] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1 p-[var(--og-model-picker-menu-padding)] text-og-fg shadow-og-lg",
            props.contentClassName,
          )}
          style={{ ...props.portalStyle, ...props.contentStyle }}
          data-testid="model-picker-content"
        >
          <ModelPolicyPickerMenu {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
