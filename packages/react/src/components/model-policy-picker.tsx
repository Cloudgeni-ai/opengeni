import { ClaudeMark } from "./claude-mark";
import { GrokMark } from "./grok-mark";
import { ChatGptMark, ModelMark, modelHasMark } from "./model-mark";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Globe2Icon,
  KeyRoundIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  Suspense,
  lazy,
  useMemo,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import {
  billingClassForMissingSelection,
  defaultModelPolicyPickerMessages,
  effectiveRows as sharedEffectiveRows,
  groupPresentationFor,
  SCOPED_BILLING_HINTS,
  type ModelPickerGroupPresentation,
  type ModelPolicyPickerMessages,
} from "../model-picker-model";
import { MENU_CHEVRON_CLASS } from "../lib/menu-styles";
import { usePortalTokenSource, usePortalTokenStyle } from "../lib/use-portal-token-style";
import {
  findPickerRow,
  labelReasoningEffort,
  modelOffersEffortChoice,
  type PickerBillingClass,
  type PickerModelRow,
} from "../model-policy";

const LazyModelPolicyPickerMenu = lazy(() =>
  import("./model-policy-picker-menu").then(({ ModelPolicyPickerPopover }) => ({
    default: ModelPolicyPickerPopover,
  })),
);

type ClientPickerModelRow = PickerModelRow<ClientModel>;

/** Presentation only; never changes model identity, billing or availability. */
export type ModelPolicyPickerGroupPresentation = ModelPickerGroupPresentation<ReactNode>;

export { defaultModelPolicyPickerMessages, groupPresentationFor, SCOPED_BILLING_HINTS };
export type { ModelPolicyPickerMessages };

export type ModelPolicyPickerProps = {
  /** Host branding for payment-source groups, shared by menu and trigger. */
  groupPresentation?: ModelPolicyPickerGroupPresentation | undefined;
  /** Lightweight deployment models. Catalog rows take precedence when supplied. */
  models?: ClientModel[] | undefined;
  /** Warn only when the draft actually contains images this model cannot view. */
  hasImageAttachments?: boolean | undefined;
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
  /** Identity of the current session scope. */
  sessionKey?: string | undefined;
  /** Prefer bottom on new-chat surfaces and top for bottom-docked composers. */
  menuSide?: "top" | "bottom" | undefined;
  /**
   * Default true: show models the way people choose them, with clean names,
   * maker marks, one "API keys" group for organization- and workspace-connected
   * keys, and one row for identical copies. Models settings passes false to
   * keep its scope-aware presentation (raw catalog labels, scoped groups).
   */
  collapseScopes?: boolean | undefined;
  /** Hide latency controls on surfaces whose saved policy does not include latency. */
  allowLatencyMode?: boolean | undefined;
  /** Settings → Models. Shown when the catalog has no model that can run. */
  connectModelsHref?: string | undefined;
  /** Classes for the portalled menu surface. Prefer --og-* tokens for theming. */
  contentClassName?: string | undefined;
  /** Inline styles for the portalled menu, applied after inherited --og-* tokens. */
  contentStyle?: CSSProperties | undefined;
  className?: string | undefined;
  /**
   * "pill" (default) is the composer's quiet rounded trigger with the effort.
   * "field" is a settings control: a bordered rectangle with the model name
   * and `triggerMeta` (for example the payer) in muted text. The effort stays
   * in the menu.
   */
  triggerStyle?: "pill" | "field" | undefined;
  /** Muted text after the model name in the "field" trigger. */
  triggerMeta?: ReactNode;
  messages?: Partial<ModelPolicyPickerMessages> | undefined;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  onLatencyModeChange: (latencyMode: LatencyMode) => void;
};

const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;

export function BillingClassMark(props: {
  billingClass: PickerBillingClass;
  presentation?: ModelPolicyPickerGroupPresentation[PickerBillingClass] | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
}) {
  const labels: Record<PickerBillingClass, string> = {
    opengeni_credits: "Models",
    external: "External provider",
    codex_subscription: "Codex",
    supergrok_subscription: "SuperGrok",
    claude_subscription: "Claude",
    byok: "API key",
    organization_byok: "API key",
  };
  if (props.presentation?.icon === null) return null;
  const label = props["aria-label"] ?? props.presentation?.label ?? labels[props.billingClass];
  const accessibility =
    label.length === 0
      ? { "aria-hidden": true as const }
      : { role: "img" as const, "aria-label": label };
  const shell = cn(
    "inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-og-fg-subtle [&>svg]:size-full [&>img]:size-full",
    props.className,
  );
  const mark = "size-3.5";
  return (
    <span
      className={shell}
      data-testid={`billing-class-icon-${props.billingClass}`}
      {...accessibility}
    >
      {props.presentation?.icon !== undefined ? (
        props.presentation.icon
      ) : props.billingClass === "opengeni_credits" ? (
        <SparklesIcon className={mark} aria-hidden />
      ) : props.billingClass === "external" ? (
        <Globe2Icon className={mark} aria-hidden />
      ) : props.billingClass === "codex_subscription" ? (
        <ChatGptMark className={mark} />
      ) : props.billingClass === "claude_subscription" ? (
        <ClaudeMark className={mark} />
      ) : props.billingClass === "supergrok_subscription" ? (
        <GrokMark className={mark} />
      ) : (
        <KeyRoundIcon className={mark} aria-hidden />
      )}
    </span>
  );
}

/**
 * The trigger shows who makes the chosen model. Subscription rails already
 * carry their maker's mark (ChatGPT, Claude, Grok), and explicit host branding
 * for a payment group always wins; otherwise API-key and deployment models show
 * the maker's logo instead of a generic key, falling back to the group mark.
 */
function SelectedModelMark(input: {
  props: ModelPolicyPickerProps;
  selected: ClientPickerModelRow | null;
}) {
  const billingClass =
    input.selected?.billingClass ?? billingClassForMissingSelection(input.props.model);
  const presentation = groupPresentationFor(input.props, billingClass);
  const model = input.selected?.catalog ?? input.props.model;
  if (input.props.collapseScopes === false) {
    return (
      <BillingClassMark
        billingClass={billingClass}
        presentation={presentation}
        aria-label={presentation?.label ?? SCOPED_MARK_LABELS[billingClass]}
        className="text-og-fg"
      />
    );
  }
  if (
    presentation?.icon !== undefined ||
    BRANDED_BILLING_CLASSES.has(billingClass) ||
    !modelHasMark(model)
  ) {
    return (
      <BillingClassMark
        billingClass={billingClass}
        presentation={presentation}
        className="text-og-fg"
      />
    );
  }
  return <ModelMark model={model} className="text-og-fg" />;
}

const SCOPED_MARK_LABELS: Partial<Record<PickerBillingClass, string>> = {
  byok: "Workspace provider account",
  organization_byok: "Organization provider account",
};

/** A selection the catalog no longer lists: its clean name (settings keep the id). */
function fallbackName(props: ModelPolicyPickerProps): string {
  return props.collapseScopes === false ? props.model : modelDisplayName(props.model);
}

const BRANDED_BILLING_CLASSES: ReadonlySet<PickerBillingClass> = new Set([
  "codex_subscription",
  "claude_subscription",
  "supergrok_subscription",
]);

export function effectiveRows(props: ModelPolicyPickerProps): ClientPickerModelRow[] {
  return sharedEffectiveRows(props);
}

export function PickerNavRow(props: {
  label: string;
  hint?: string | undefined;
  icon?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
  description?: string | undefined;
  active?: boolean | undefined;
  testId?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      title={props.title}
      aria-description={props.description}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        // The one menu row (lib/menu-styles.ts), with density tokens for embedders.
        "flex min-h-8 w-full cursor-pointer items-center gap-2.5 rounded-og-md px-[var(--og-model-picker-row-padding-x)] py-[var(--og-model-picker-row-padding-y)] text-left text-og-fg outline-hidden transition-colors duration-[120ms] hover:bg-og-hover focus-visible:bg-og-hover focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-og-accent/55 pointer-coarse:min-h-11",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-og-menu">{props.label}</span>
        {props.hint ? (
          <span className="mt-0.5 block truncate text-og-sm text-og-fg-muted">{props.hint}</span>
        ) : null}
      </span>
      {props.trailing ? <span className="ml-auto shrink-0">{props.trailing}</span> : null}
      {props.showChevron === false ? null : <ChevronRightIcon className={MENU_CHEVRON_CLASS} />}
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
    <div className="mb-1.5 flex min-h-9 items-center gap-1 border-b border-og-border pb-1.5">
      <button
        type="button"
        onClick={props.onBack}
        data-testid="model-picker-back"
        className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-og-md pr-2.5 text-left text-og-fg outline-hidden transition-colors duration-[120ms] hover:bg-og-hover focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-og-accent/55 pointer-coarse:min-h-11"
      >
        <span className="flex size-8 shrink-0 items-center justify-center text-og-fg-muted">
          <ChevronLeftIcon className="size-4" />
        </span>
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

/** @internal Shared controlled/uncontrolled state seam. */
export function useModelPolicyPickerState(props: ModelPolicyPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setUncontrolledOpen(next);
    props.onOpenChange?.(next);
  };
  return { open, setOpen, rows: effectiveRows(props) };
}

export function ModelPolicyPicker(props: ModelPolicyPickerProps) {
  const contentId = useId();
  const trigger = usePortalTokenSource<HTMLButtonElement>();
  const portalStyle = usePortalTokenStyle(trigger.source);
  const messages = useMemo(
    () => ({ ...defaultModelPolicyPickerMessages, ...props.messages }),
    [props.messages],
  );
  const { open, setOpen, rows } = useModelPolicyPickerState(props);
  const selected = findPickerRow(rows, props.model);
  const needsModel =
    !rows.some((row) => row.selectable) && (rows.length > 0 || Boolean(props.connectModelsHref));

  if (props.loading) {
    return (
      <span
        className={cn(
          "og-root inline-flex h-8 w-40 shrink-0 animate-pulse rounded-full bg-og-surface-2",
          props.triggerStyle === "field" && "w-[180px] rounded-og-md",
          props.className,
        )}
        aria-label={messages.loading}
        data-testid="model-picker-loading"
      />
    );
  }
  if (props.triggerStyle === "field") {
    return (
      <>
        <button
          ref={trigger.ref}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          data-state={open ? "open" : "closed"}
          data-trigger-style="field"
          onClick={() => setOpen(!open)}
          disabled={props.disabled}
          aria-label={messages.label}
          className={cn(
            "og-root inline-flex h-8 min-w-[180px] max-w-full items-center gap-2 rounded-og-md border border-og-border bg-og-surface px-2.5 text-sm text-og-fg outline-hidden transition-colors hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
            props.className,
          )}
        >
          {needsModel ? (
            <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <SelectedModelMark props={props} selected={selected} />
          )}
          <span className="min-w-0 truncate font-medium">
            {needsModel ? messages.connectTitle : (selected?.label ?? fallbackName(props))}
          </span>
          {props.triggerMeta && !needsModel ? (
            <span className="min-w-0 shrink-[9999] truncate text-og-fg-muted">
              {props.triggerMeta}
            </span>
          ) : null}
          <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-og-fg-muted" />
        </button>
        {open ? (
          <Suspense fallback={null}>
            <LazyModelPolicyPickerMenu
              {...props}
              anchor={trigger.currentRef}
              contentId={contentId}
              portalStyle={portalStyle}
              onOpenChange={setOpen}
            />
          </Suspense>
        ) : null}
      </>
    );
  }
  return (
    <>
      <button
        ref={trigger.ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        data-state={open ? "open" : "closed"}
        onClick={() => setOpen(!open)}
        disabled={props.disabled}
        aria-label={messages.label}
        className={cn(
          "og-root og-model-policy-trigger inline-flex h-[var(--og-model-picker-trigger-height)] min-w-0 max-w-64 items-center gap-1 rounded-full border px-2.5 text-og-control outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:max-w-[7.5rem] max-sm:px-2",
          // With no usable model the pill is the one thing that unblocks the
          // composer, so it takes the primary wash.
          needsModel
            ? "border-og-primary-border bg-og-primary text-og-primary-fg hover:bg-og-primary-hover"
            : "border-transparent text-og-fg-muted hover:border-og-border hover:bg-og-surface-2 hover:text-og-fg",
          props.className,
        )}
      >
        {needsModel ? (
          <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <SelectedModelMark props={props} selected={selected} />
        )}
        <span className="og-model-policy-label-full min-w-0 truncate font-medium text-og-fg max-sm:hidden @max-[20rem]/model-controls:hidden">
          {needsModel ? messages.connectTitle : (selected?.label ?? fallbackName(props))}
        </span>
        <span className="og-model-policy-label-short min-w-0 truncate font-medium text-og-fg sm:hidden @max-[20rem]/model-controls:block">
          {needsModel
            ? messages.connectTitle
            : (selected?.shortLabel ?? selected?.label ?? fallbackName(props))}
        </span>
        {selected && !needsModel && modelOffersEffortChoice(selected.catalog) ? (
          <span
            className="og-model-policy-effort min-w-0 shrink-[9999] truncate"
            title={labelReasoningEffort(props.effort)}
          >
            {labelReasoningEffort(props.effort)}
          </span>
        ) : null}
        {props.latencyMode === "fast" && !needsModel ? (
          <ZapIcon
            className="size-3.5 shrink-0 fill-current stroke-current text-og-fg"
            aria-label={messages.fast}
            data-testid="model-picker-fast-icon"
          />
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0" />
      </button>

      {open ? (
        <Suspense fallback={null}>
          <LazyModelPolicyPickerMenu
            {...props}
            anchor={trigger.currentRef}
            contentId={contentId}
            portalStyle={portalStyle}
            onOpenChange={setOpen}
          />
        </Suspense>
      ) : null}
    </>
  );
}
