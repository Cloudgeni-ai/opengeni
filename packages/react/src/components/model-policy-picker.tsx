import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  ZapIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from "react";
import { cn } from "../lib/cn";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";
import {
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  findPickerRow,
  groupPickerRowsByBillingClass,
  labelReasoningEffort,
  projectClientModelRows,
  runnableLatencyModesForModel,
  type PickerBillingClass,
  type PickerModelRow,
} from "../model-policy";

type ClientPickerModelRow = PickerModelRow<ClientModel>;

type NavLevel = "providers" | "models" | "thinking";

type PickerNavState = {
  level: NavLevel;
  rail: PickerBillingClass | null;
  modelId: string | null;
};

type NavUpdater = PickerNavState | ((previous: PickerNavState) => PickerNavState);

export type ModelPolicyPickerMessages = {
  label: string;
  loading: string;
  noModels: string;
  thinking: string;
  fast: string;
  fastRateHint: string;
  codexOnly: string;
  billingHints: Record<PickerBillingClass, string>;
};

export const defaultModelPolicyPickerMessages: ModelPolicyPickerMessages = {
  label: "Model and effort",
  loading: "Loading model catalog…",
  noModels: "No models available.",
  thinking: "Thinking",
  fast: "Fast",
  fastRateHint: "2× rate",
  codexOnly: "Codex-only session",
  billingHints: {
    opengeni_credits: "Will use credits",
    codex_subscription: "ChatGPT / Codex plan",
    byok: "Billed to your AI Gateway",
  },
};

export type ModelPolicyPickerProps = {
  /** Lightweight deployment models. Catalog rows take precedence when supplied. */
  models?: ClientModel[] | undefined;
  /** Catalog-backed rows with availability and billing-class truth. */
  rows?: PickerModelRow[] | undefined;
  model: string;
  effort: ReasoningEffort;
  latencyMode: LatencyMode;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  /** Controlled menu state. Omit for the built-in uncontrolled behavior. */
  open?: boolean | undefined;
  /** Initial menu state when `open` is uncontrolled. */
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Non-Codex models stay visible but cannot be selected. */
  codexOnly?: boolean | undefined;
  /** Resets drill-down navigation when the session scope changes. */
  sessionKey?: string | undefined;
  /** Prefer bottom on new-chat surfaces and top for bottom-docked composers. */
  menuSide?: "top" | "bottom" | undefined;
  /** Classes for the portalled menu surface. Prefer --og-* tokens for theming. */
  contentClassName?: string | undefined;
  /** Inline styles for the portalled menu, applied after inherited --og-* tokens. */
  contentStyle?: CSSProperties | undefined;
  className?: string | undefined;
  messages?: Partial<ModelPolicyPickerMessages> | undefined;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  onLatencyModeChange: (latencyMode: LatencyMode) => void;
};

const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;

function OpenGeniMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 140 133"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <g transform="translate(-17.5,-20.999893188476562) scale(1.75)">
        <g transform="translate(0,-952.36218)">
          <path d="m 60.7828,964.36215 27.1809,0.8834 -27.1809,25.9958 z m -1.9745,1.4513 0,26.7845 -25.2681,0 c 8.6166,-8.7334 16.8796,-17.8103 25.2681,-26.7845 z m 27.7053,3.628 3.4864,1.1989 -12.5877,7.4768 z m -68.1835,2.9656 5.5226,0 12.8654,14.0705 -5.9854,6.1204 -12.4026,0 c 9e-4,-6.7347 0,-13.4597 0,-20.1909 z m -1.9746,1.2304 0,5.8364 -6.3555,0 z m 3.363,20.9796 38.627,0 -10.7675,29.43465 z m 39.0898,4.54286 0,41.20229 -12.5878,-6.8775 c 4.1972,-11.443 8.3886,-22.879 12.5878,-34.32479 z" />
        </g>
      </g>
    </svg>
  );
}

function ChatGptMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3653-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8414 3.3698-2.02 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.783-2.7622a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export function BillingClassMark(props: {
  billingClass: PickerBillingClass;
  className?: string | undefined;
  "aria-label"?: string | undefined;
}) {
  const labels: Record<PickerBillingClass, string> = {
    opengeni_credits: "OpenGeni",
    codex_subscription: "Codex",
    byok: "Bring your own key",
  };
  const label = props["aria-label"] ?? labels[props.billingClass];
  const accessibility =
    label.length === 0
      ? { "aria-hidden": true as const }
      : { role: "img" as const, "aria-label": label };
  const shell = cn(
    "inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-og-fg-subtle",
    props.className,
  );
  const mark = "size-3.5";
  return (
    <span
      className={shell}
      data-testid={`billing-class-icon-${props.billingClass}`}
      {...accessibility}
    >
      {props.billingClass === "opengeni_credits" ? (
        <OpenGeniMark className={mark} />
      ) : props.billingClass === "codex_subscription" ? (
        <ChatGptMark className={mark} />
      ) : (
        <KeyRoundIcon className={mark} aria-hidden />
      )}
    </span>
  );
}

function isCodexModel(model: ClientModel): boolean {
  return model.id.startsWith("codex/") || model.source === "codex";
}

function applyCodexOnly(
  rows: ClientPickerModelRow[],
  codexOnly: boolean,
  unavailableReason: string,
): ClientPickerModelRow[] {
  if (!codexOnly) return rows;
  return rows.map((row) =>
    isCodexModel(row.catalog)
      ? row
      : {
          ...row,
          selectable: false,
          unavailableReason: row.unavailableReason ?? unavailableReason,
        },
  );
}

function effectiveRows(props: ModelPolicyPickerProps): ClientPickerModelRow[] {
  const rows = props.rows !== undefined ? props.rows : projectClientModelRows(props.models ?? []);
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  return applyCodexOnly(rows, props.codexOnly === true, messages.codexOnly);
}

function defaultNavState(rows: ClientPickerModelRow[], modelId: string): PickerNavState {
  const selected = findPickerRow(rows, modelId);
  if (!selected) {
    const rails = new Set(rows.map((row) => row.billingClass));
    const onlyRail = rails.size === 1 ? rows[0]?.billingClass : null;
    return onlyRail
      ? { level: "models", rail: onlyRail, modelId: null }
      : { level: "providers", rail: null, modelId: null };
  }
  return { level: "thinking", rail: selected.billingClass, modelId: selected.id };
}

function usePickerNavState(
  sessionKey: string | undefined,
  rows: ClientPickerModelRow[],
  model: string,
): [PickerNavState, (next: NavUpdater) => void] {
  const [state, setState] = useState<PickerNavState>(() => defaultNavState(rows, model));
  useEffect(() => {
    setState(defaultNavState(rows, model));
    // The menu deliberately preserves its drill-down while the same session is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);
  return [state, setState];
}

export function PickerNavRow(props: {
  label: string;
  hint?: string | undefined;
  icon?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
  active?: boolean | undefined;
  testId?: string | undefined;
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
        "flex w-full cursor-pointer items-center gap-2 rounded-og-sm px-[var(--og-model-picker-row-padding-x)] py-[var(--og-model-picker-row-padding-y)] text-left text-og-fg outline-none transition-colors hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent/40",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-og-menu", props.active && "font-medium")}>
          {props.label}
        </span>
        {props.hint ? (
          <span className="mt-0.5 block truncate text-og-control text-og-fg-subtle">
            {props.hint}
          </span>
        ) : null}
      </span>
      {props.trailing ? <span className="ml-auto shrink-0">{props.trailing}</span> : null}
      {props.showChevron === false ? null : (
        <ChevronRightIcon className="size-3.5 shrink-0 text-og-fg-subtle" />
      )}
    </button>
  );
}

export function PickerBackHeader(props: {
  label: string;
  icon?: ReactNode;
  onBack: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center gap-0.5 border-b border-og-border/70 px-0.5 pb-1.5">
      <button
        type="button"
        onClick={props.onBack}
        data-testid="model-picker-back"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-og-sm px-1.5 py-1.5 text-left text-og-fg outline-none transition-colors hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent/40"
      >
        <ChevronLeftIcon className="size-3.5 shrink-0 text-og-fg-subtle" />
        {props.icon}
        <span className="min-w-0 flex-1 truncate text-og-menu font-medium">{props.label}</span>
      </button>
      {props.trailing ? <div className="relative z-10 shrink-0">{props.trailing}</div> : null}
    </div>
  );
}

export function PickerAnimatedPage(props: {
  pageKey: string;
  direction: 1 | -1;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      key={props.pageKey}
      initial={reduceMotion ? false : { x: props.direction * 14, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: SLIDE_EASE }}
      className="w-full"
    >
      {props.children}
    </motion.div>
  );
}

export function ModelPolicyPickerMenu(
  props: ModelPolicyPickerProps & {
    nav?: PickerNavState | undefined;
    onNavChange?: ((next: NavUpdater) => void) | undefined;
  },
) {
  const messages = useMemo(
    () => ({ ...defaultModelPolicyPickerMessages, ...props.messages }),
    [props.messages],
  );
  const rows = effectiveRows(props);
  const groups = useMemo(() => groupPickerRowsByBillingClass(rows), [rows]);
  const [localNav, setLocalNav] = usePickerNavState(
    props.nav === undefined ? props.sessionKey : undefined,
    rows,
    props.model,
  );
  const nav = props.nav ?? localNav;
  const setNav = props.onNavChange ?? setLocalNav;
  const [direction, setDirection] = useState<1 | -1>(1);

  const effectiveNav =
    nav.level === "providers" && groups.length === 1
      ? { level: "models" as const, rail: groups[0]!.billingClass, modelId: null }
      : nav;
  const activeGroup =
    effectiveNav.rail === null
      ? undefined
      : groups.find((group) => group.billingClass === effectiveNav.rail);
  const focusModel =
    effectiveNav.modelId === null ? undefined : findPickerRow(rows, effectiveNav.modelId);
  const selectedRow = findPickerRow(rows, props.model);
  const { latencyMode, loading, onLatencyModeChange } = props;

  useEffect(() => {
    if (loading || !selectedRow?.selectable) return;
    const supportsCurrentMode = runnableLatencyModesForModel(selectedRow.catalog).includes(
      latencyMode,
    );
    if (!supportsCurrentMode && latencyMode !== "standard") {
      onLatencyModeChange("standard");
    }
  }, [latencyMode, loading, onLatencyModeChange, selectedRow]);

  const go = (next: PickerNavState, nextDirection: 1 | -1) => {
    setDirection(nextDirection);
    setNav(next);
  };

  const selectEffort = (row: ClientPickerModelRow, effort: ReasoningEffort) => {
    if (!row.selectable) return;
    if (row.id !== props.model) props.onModelChange(row.id);
    props.onEffortChange(coerceReasoningEffortForModel(row.catalog, effort));
  };

  const pageKey =
    effectiveNav.level === "providers"
      ? "providers"
      : effectiveNav.level === "models"
        ? `models:${effectiveNav.rail ?? ""}`
        : `thinking:${effectiveNav.modelId ?? ""}`;

  let body: ReactNode;
  if (props.loading) {
    body = <p className="px-2 py-3 text-og-control text-og-fg-subtle">{messages.loading}</p>;
  } else if (groups.length === 0) {
    body = <p className="px-2 py-3 text-og-control text-og-fg-subtle">{messages.noModels}</p>;
  } else if (effectiveNav.level === "providers") {
    body = (
      <div className="flex flex-col gap-0.5" data-testid="model-picker-providers">
        {groups.map((group) => (
          <PickerNavRow
            key={group.billingClass}
            label={group.label}
            hint={messages.billingHints[group.billingClass]}
            icon={<BillingClassMark billingClass={group.billingClass} />}
            active={selectedRow?.billingClass === group.billingClass}
            testId={`model-picker-rail-${group.billingClass}`}
            onClick={() => go({ level: "models", rail: group.billingClass, modelId: null }, 1)}
          />
        ))}
      </div>
    );
  } else if (effectiveNav.level === "models" && activeGroup) {
    body = (
      <div data-testid="model-picker-models">
        {groups.length > 1 ? (
          <PickerBackHeader
            label={activeGroup.label}
            icon={<BillingClassMark billingClass={activeGroup.billingClass} />}
            onBack={() => go({ level: "providers", rail: null, modelId: null }, -1)}
          />
        ) : null}
        <div className="flex flex-col gap-0.5">
          {activeGroup.rows.map((row) => (
            <PickerNavRow
              key={`${row.billingClass}:${row.id}`}
              label={row.label}
              hint={row.unavailableReason ?? undefined}
              disabled={!row.selectable}
              title={row.unavailableReason ?? undefined}
              active={row.id === props.model}
              testId={`model-picker-choice-${row.id}`}
              onClick={() => {
                if (row.selectable) {
                  go({ level: "thinking", rail: row.billingClass, modelId: row.id }, 1);
                }
              }}
            />
          ))}
        </div>
      </div>
    );
  } else if (effectiveNav.level === "thinking" && focusModel) {
    const activeModel = focusModel.id === props.model;
    const supportsFast = runnableLatencyModesForModel(focusModel.catalog).includes("fast");
    body = (
      <div data-testid="model-picker-reasoning">
        <PickerBackHeader
          label={focusModel.label}
          icon={<BillingClassMark billingClass={focusModel.billingClass} />}
          onBack={() => go({ level: "models", rail: focusModel.billingClass, modelId: null }, -1)}
          trailing={
            supportsFast ? (
              <button
                type="button"
                disabled={!focusModel.selectable}
                aria-pressed={activeModel && props.latencyMode === "fast"}
                aria-label={
                  activeModel && props.latencyMode === "fast"
                    ? `Disable ${messages.fast}`
                    : `Enable ${messages.fast}`
                }
                title={`${messages.fast} · ${messages.fastRateHint}`}
                data-testid="model-picker-fast"
                onClick={() => {
                  if (!activeModel) {
                    props.onModelChange(focusModel.id);
                    props.onEffortChange(
                      coerceReasoningEffortForModel(focusModel.catalog, props.effort),
                    );
                  }
                  props.onLatencyModeChange(
                    activeModel && props.latencyMode === "fast" ? "standard" : "fast",
                  );
                }}
                className={cn(
                  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-og-sm text-og-fg-subtle outline-none transition-colors hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                  activeModel && props.latencyMode === "fast" && "text-og-fg",
                )}
              >
                <ZapIcon
                  className={cn(
                    "size-3.5",
                    activeModel && props.latencyMode === "fast" && "fill-current",
                  )}
                />
              </button>
            ) : null
          }
        />
        <p className="px-2.5 pt-1 pb-1 text-og-control font-medium tracking-wide text-og-fg-subtle uppercase">
          {messages.thinking}
        </p>
        {focusModel.catalog.capabilities?.inputModalities.includes("image") === false ? (
          <p className="px-2.5 pb-1.5 text-og-control leading-relaxed text-og-fg-subtle">
            Unsupported attachments stay in the session but are hidden from this model.
          </p>
        ) : null}
        <div className="flex flex-col gap-0.5">
          {effortOptionsForModel(focusModel.catalog).map((effort) => {
            const selected = activeModel && effort === props.effort;
            return (
              <button
                key={effort}
                type="button"
                disabled={!focusModel.selectable}
                onClick={() => selectEffort(focusModel, effort)}
                className={cn(
                  "flex h-[var(--og-model-picker-effort-height)] w-full cursor-pointer items-center rounded-og-sm px-[var(--og-model-picker-row-padding-x)] text-left text-og-menu text-og-fg outline-none transition-colors hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                  selected && "bg-og-surface-2",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{labelReasoningEffort(effort)}</span>
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
    body = (
      <div className="flex flex-col gap-0.5" data-testid="model-picker-providers">
        {groups.map((group) => (
          <PickerNavRow
            key={group.billingClass}
            label={group.label}
            hint={messages.billingHints[group.billingClass]}
            icon={<BillingClassMark billingClass={group.billingClass} />}
            testId={`model-picker-rail-${group.billingClass}`}
            onClick={() => go({ level: "models", rail: group.billingClass, modelId: null }, 1)}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="model-picker-menu" className="relative overflow-hidden">
      {props.error ? (
        <p className="px-2 py-1 text-og-control text-og-status-failed" role="alert">
          {props.error}
        </p>
      ) : null}
      <PickerAnimatedPage pageKey={pageKey} direction={direction}>
        {body}
      </PickerAnimatedPage>
    </div>
  );
}

export function ModelPolicyPicker(props: ModelPolicyPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setUncontrolledOpen(next);
    props.onOpenChange?.(next);
  };
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const portalStyle = usePortalTokenStyle(triggerRef);
  const messages = useMemo(
    () => ({ ...defaultModelPolicyPickerMessages, ...props.messages }),
    [props.messages],
  );
  const rows = effectiveRows(props);
  const [nav, setNav] = usePickerNavState(props.sessionKey, rows, props.model);
  const selected = findPickerRow(rows, props.model);

  if (props.loading) {
    return (
      <span
        className={cn(
          "inline-flex h-8 w-40 shrink-0 animate-pulse rounded-full bg-og-surface-2",
          props.className,
        )}
        aria-label={messages.loading}
        data-testid="model-picker-loading"
      />
    );
  }
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={props.disabled}
          aria-label={messages.label}
          className={cn(
            "og-root inline-flex h-[var(--og-model-picker-trigger-height)] min-w-0 max-w-64 items-center gap-1 rounded-full border border-transparent px-2.5 text-og-control text-og-fg-muted outline-none transition-colors hover:border-og-border hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:max-w-[7.5rem] max-sm:px-2",
            props.className,
          )}
        >
          <BillingClassMark
            billingClass={
              selected?.billingClass ??
              (props.model.startsWith("codex/") ? "codex_subscription" : "opengeni_credits")
            }
            className="text-og-fg"
          />
          <span className="min-w-0 truncate font-medium text-og-fg max-sm:hidden">
            {selected?.label ?? props.model}
          </span>
          <span className="min-w-0 truncate font-medium text-og-fg sm:hidden">
            {selected?.shortLabel ?? selected?.label ?? props.model}
          </span>
          <span className="max-sm:hidden">{labelReasoningEffort(props.effort)}</span>
          {props.latencyMode === "fast" ? (
            <ZapIcon
              className="size-3.5 shrink-0 fill-current stroke-current text-og-fg"
              aria-label={messages.fast}
              data-testid="model-picker-fast-icon"
            />
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side={props.menuSide ?? "bottom"}
          sideOffset={8}
          collisionPadding={12}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={cn(
            "og-root z-50 flex max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--og-model-picker-menu-width)] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1 p-[var(--og-model-picker-menu-padding)] text-og-fg shadow-og-lg",
            props.contentClassName,
          )}
          style={{ ...portalStyle, ...props.contentStyle }}
          data-testid="model-picker-content"
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ModelPolicyPickerMenu {...props} nav={nav} onNavChange={setNav} />
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
