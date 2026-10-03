import type { ClientModel, ReasoningEffort } from "@opengeni/sdk";
import { ArrowRightIcon, CheckIcon, SearchIcon, ZapIcon } from "lucide-react";
import { useRef, useState, type RefObject, type CSSProperties } from "react";
import { Popover, RadioGroup } from "radix-ui";
import { cn } from "../lib/cn";
import {
  MENU_CHECK_CLASS,
  MENU_LABEL_CLASS,
  MENU_NOTE_CLASS,
  MENU_SURFACE_CLASS,
} from "../lib/menu-styles";
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
import { ModelMark } from "./model-mark";
type ClientPickerModelRow = PickerModelRow<ClientModel>;

/** Model selection stays flat; reasoning never becomes a navigation destination. */
export function ModelPolicyPickerMenu(props: ModelPolicyPickerProps) {
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  const [query, setQuery] = useState("");
  const rows = effectiveRows(props);
  const selected = findPickerRow(rows, props.model);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((row) => {
    const description = props.groupPresentation?.[row.billingClass]?.description;
    const text =
      `${row.label} ${row.id} ${row.providerLabel} ${row.billingClassLabel} ${description === undefined ? payerSummaryForModel(row.catalog) : (description ?? "")}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const matchingIds = new Set(filtered.map((row) => row.id));
  const groups = groupPickerRowsByBillingClass(rows, {
    codexOnly: props.codexOnly === true,
    selectedId: props.model,
  })
    .map((group) => {
      const override = props.groupPresentation?.[group.billingClass]?.description;
      return {
        ...group,
        label: props.groupPresentation?.[group.billingClass]?.label ?? group.label,
        rows: group.rows.filter((row) => matchingIds.has(row.id)),
        description:
          override === undefined
            ? group.billingClass === "opengeni_credits"
              ? null
              : messages.billingHints[group.billingClass]
            : override,
      };
    })
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
  };
  const modelRow = (row: ClientPickerModelRow) => (
    <PickerNavRow
      key={row.id}
      icon={<ModelMark model={row.catalog} className="size-4 text-og-fg-muted" />}
      label={row.label}
      hint={row.unavailableReason ?? undefined}
      disabled={props.disabled || !row.selectable}
      title={[row.label, row.unavailableReason].filter(Boolean).join(" · ")}
      active={row.selectable && row.id === props.model}
      showChevron={false}
      trailing={
        row.catalog.cost === "free" || row.id === props.model ? (
          <span className="flex items-center gap-2">
            {row.catalog.cost === "free" ? (
              <span className="rounded-full bg-og-surface-2 px-1.5 py-0.5 text-og-control text-og-fg-muted">
                {messages.free}
              </span>
            ) : null}
            {row.id === props.model ? (
              <CheckIcon className={MENU_CHECK_CLASS} aria-label={messages.selected} />
            ) : null}
          </span>
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
      {rows.some((row) => row.selectable) ? (
        <div className="border-b border-og-border py-1">
          <label className="og-model-policy-search flex items-center gap-2 px-2.5 py-0.5">
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
              className="og-model-policy-search-input h-8 min-w-0 flex-1 bg-transparent text-og-menu text-og-fg outline-hidden placeholder:text-og-fg-subtle"
            />
          </label>
        </div>
      ) : null}
      {props.error ? (
        <p className={cn(MENU_NOTE_CLASS, "text-og-sm text-og-status-failed")} role="alert">
          {props.error}
        </p>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
        data-testid="model-picker-models"
      >
        {props.loading ? (
          // Rows at the menu's row height, never a sentence, so nothing jumps.
          <div role="status" aria-label={messages.loading}>
            {[58, 44, 66, 50].map((width) => (
              <div key={width} aria-hidden="true" className="flex h-8 items-center gap-3 px-2.5">
                <span className="size-4 shrink-0 animate-pulse rounded bg-og-surface-2" />
                <span
                  className="h-2.5 animate-pulse rounded bg-og-surface-2"
                  style={{ width: `${width}%` }}
                />
              </div>
            ))}
          </div>
        ) : rows.some((row) => row.selectable) ? (
          <>
            {groups.map((group) => (
              <section
                key={group.billingClass}
                aria-label={group.label}
                className="[&+section]:mt-1.5 [&+section]:border-t [&+section]:border-og-border [&+section]:pt-1.5"
              >
                <div className={cn(MENU_LABEL_CLASS, "flex items-center gap-2")}>
                  <BillingClassMark
                    billingClass={group.billingClass}
                    presentation={props.groupPresentation?.[group.billingClass]}
                    aria-label=""
                  />
                  <span className="min-w-0 break-words">{group.label}</span>
                </div>
                {group.description ? (
                  <p className="break-words px-2.5 pb-1 text-og-sm text-og-fg-muted">
                    {group.description}
                  </p>
                ) : null}
                {group.rows.map(modelRow)}
              </section>
            ))}
            {filtered.length === 0 ? (
              <p className={MENU_NOTE_CLASS}>
                {words.length ? messages.noMatches : messages.noModels}
              </p>
            ) : null}
          </>
        ) : props.connectModelsHref || rows.length > 0 ? (
          <ConnectModelsPanel href={props.connectModelsHref} messages={messages} />
        ) : (
          <p className={MENU_NOTE_CLASS}>{messages.noModels}</p>
        )}
      </div>
      {rows.some((row) => row.selectable) &&
      selected &&
      ((props.hasImageAttachments &&
        selected.catalog.capabilities?.inputModalities.includes("image") === false) ||
        (effortOptionsForModel(selected.catalog).length > 1 &&
          selected.catalog.capabilities?.reasoning.runnable !== false) ||
        (props.allowLatencyMode !== false &&
          runnableLatencyModesForModel(selected.catalog).includes("fast"))) ? (
        <div className="border-t border-og-border px-2.5 py-2.5">
          {props.hasImageAttachments &&
          selected.catalog.capabilities?.inputModalities.includes("image") === false ? (
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

const CONNECT_MODEL_OPTIONS: Array<{
  billingClass: "codex_subscription" | "supergrok_subscription" | "byok" | "external";
  title: string;
  detail: string;
}> = [
  { billingClass: "codex_subscription", title: "Codex", detail: "ChatGPT" },
  { billingClass: "supergrok_subscription", title: "SuperGrok", detail: "xAI" },
  { billingClass: "byok", title: "AI Gateway", detail: "Vercel" },
  { billingClass: "external", title: "OpenRouter", detail: "API key" },
];

function ConnectModelsPanel(props: {
  href: string | undefined;
  messages: typeof defaultModelPolicyPickerMessages;
}) {
  return (
    <div className="px-1.5 pb-1.5 pt-2" data-testid="model-picker-connect">
      <div className="px-1.5 pb-3">
        <p className="text-og-menu font-medium tracking-tight text-og-fg">
          {props.messages.connectTitle}
        </p>
        <p className="mt-1 text-og-control leading-snug text-og-fg-subtle">
          {props.messages.connectBody}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {CONNECT_MODEL_OPTIONS.map((option) => {
          const content = (
            <>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-og-md bg-og-surface-2 text-og-fg">
                <BillingClassMark
                  billingClass={option.billingClass}
                  aria-label=""
                  className="size-4 text-og-fg"
                />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-og-control font-medium text-og-fg">
                  {option.title}
                </span>
                <span className="block truncate text-og-control text-og-fg-subtle">
                  {option.detail}
                </span>
              </span>
            </>
          );
          const className =
            "flex min-w-0 items-center gap-2 rounded-og-md px-1.5 py-1.5 outline-hidden transition-colors hover:bg-og-hover focus-visible:ring-2 focus-visible:ring-og-accent/40";
          return props.href ? (
            <a key={option.title} href={props.href} className={className}>
              {content}
            </a>
          ) : (
            <div key={option.title} className={className}>
              {content}
            </div>
          );
        })}
      </div>
      {props.href ? (
        <a
          href={props.href}
          className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-og-md border border-og-primary-border bg-og-primary text-og-primary-fg hover:bg-og-primary-hover text-og-control font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-og-accent/40"
        >
          {props.messages.connectAction}
          <ArrowRightIcon className="size-3.5" aria-hidden />
        </a>
      ) : (
        <p className="px-1.5 pt-3 text-og-control text-og-fg-subtle">{props.messages.noModels}</p>
      )}
    </div>
  );
}

function ModelThinkingControls(props: ModelPolicyPickerProps) {
  const selected = findPickerRow(effectiveRows(props), props.model);
  if (!selected) return null;
  const efforts = effortOptionsForModel(selected.catalog);
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  const supportsFast = runnableLatencyModesForModel(selected.catalog).includes("fast");
  const showThinking =
    efforts.length > 1 && selected.catalog.capabilities?.reasoning.runnable !== false;
  const showFast = supportsFast && props.allowLatencyMode !== false;
  if (!showThinking && !showFast) return null;
  return (
    <div className="space-y-2 text-og-control" data-testid="model-picker-reasoning">
      <div className="flex min-h-7 items-center justify-between gap-3">
        {showThinking ? <span className="text-og-fg-subtle">{messages.thinking}</span> : <span />}
        {showFast ? (
          <button
            type="button"
            data-testid="model-picker-fast"
            disabled={props.disabled || !selected.selectable}
            aria-pressed={props.latencyMode === "fast"}
            title={messages.fast + " · " + messages.fastRateHint}
            onClick={() =>
              props.onLatencyModeChange(props.latencyMode === "fast" ? "standard" : "fast")
            }
            className="flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-og-sm px-2 text-og-fg-muted hover:bg-og-hover focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
          >
            <ZapIcon className={cn("size-3.5", props.latencyMode === "fast" && "fill-current")} />
            {messages.fast}
            <span className="text-og-fg-subtle">{messages.fastRateHint}</span>
          </button>
        ) : null}
      </div>
      {showThinking ? (
        <RadioGroup.Root
          aria-label={messages.thinkingEffort}
          value={coerceReasoningEffortForModel(selected.catalog, props.effort)}
          disabled={props.disabled || !selected.selectable}
          onValueChange={(value) => props.onEffortChange(value as ReasoningEffort)}
          orientation="horizontal"
          className="flex flex-wrap gap-0.5 rounded-og-md bg-og-surface-2 p-0.5"
        >
          {efforts.map((effort) => (
            <RadioGroup.Item
              key={effort}
              value={effort}
              aria-label={labelReasoningEffort(effort)}
              title={labelReasoningEffort(effort)}
              className="min-h-8 min-w-10 flex-1 cursor-pointer whitespace-nowrap rounded-og-sm px-1.5 text-og-control text-og-fg-muted outline-hidden transition-colors hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 data-[state=checked]:bg-og-surface-1 data-[state=checked]:text-og-fg data-[state=checked]:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {effort === "xhigh" ? "X-high" : labelReasoningEffort(effort)}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
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
            MENU_SURFACE_CLASS,
            "og-root og-model-policy-menu z-50 flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[22rem] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-[var(--og-model-picker-menu-padding)]",
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
