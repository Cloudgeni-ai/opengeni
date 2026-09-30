import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ElementType,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowLeftIcon, LoaderCircleIcon, LockIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/error-message";
import { Notice } from "@/components/ui/notice";
import { SectionFrameReset } from "@/components/ui/section-variant";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsAction } from "@/lib/analytics-actions";
import { apiErrorTechnicalFacts, userErrorTextWithoutReference } from "@/lib/api-error";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   FormFrame, FormDialog, FormPage and FormInline (brief 7.15).

   One anatomy for every create and edit form: a title, one vertical column of
   fields, server errors inside the form, and a footer with Cancel (ghost) and
   one primary. Enter submits; Cmd/Ctrl+Enter submits from a textarea.

   The frame renders in four presentations:
   - "dialog": centred 480/560/640px panel; a bottom sheet on phones.
   - "sheet":  full-height right sheet for longer forms (see form-sheet.tsx).
   - "page":   a full page with a back link, for long creates.
   - "inline": a panel in the page flow.

   `onSubmit` may be async. Returning `false` keeps the form open (for
   example after client validation); throwing shows the error's message
   inside the form. Anything else counts as success and calls `onSubmitted`.
   -------------------------------------------------------------------------- */

export type FormVariant = "dialog" | "sheet" | "page" | "inline";

/** A form page's frame: the DetailPage column (960px, 32px sides, 16px on phones). */
const PAGE_FRAME = "mx-auto w-full max-w-[960px] px-8 max-sm:px-4 @max-[26rem]/form:px-4";
export type FormDialogSize = "sm" | "md" | "lg";

type SubmitResult = void | boolean;

interface FormChrome {
  Title: ElementType;
  Description: ElementType;
  /** Radix Close, rendered asChild around the close button. */
  Close: ElementType | null;
}

const FormChromeContext = createContext<FormChrome | null>(null);

const DIALOG_CHROME: FormChrome = {
  Title: DialogPrimitive.Title,
  Description: DialogPrimitive.Description,
  Close: DialogPrimitive.Close,
};

/** Provides Radix title, description and close parts to a frame inside a Radix dialog. */
export function FormDialogChromeProvider({ children }: { children: ReactNode }) {
  return <FormChromeContext.Provider value={DIALOG_CHROME}>{children}</FormChromeContext.Provider>;
}

export interface FormFrameProps {
  /** Presentation. Default "dialog". */
  variant?: FormVariant;
  /** Names the object and the outcome: "New variable set", "Replace value". */
  title: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  /** A 40px tile or icon before the title (dialog and sheet only). */
  leading?: ReactNode;
  /** Right of the title, for example a status badge. */
  headerAside?: ReactNode;
  /** The fields. Wrap them in `FieldStack` for the 24px rhythm. */
  children?: ReactNode;
  /** Verb + object: "Create variable set". */
  submitLabel: ReactNode;
  /** Shown with a spinner while submitting: "Creating…". */
  pendingLabel?: ReactNode;
  /** Closed product-analytics label for the primary button (never derived from text). */
  submitAnalyticsAction?: AnalyticsAction | null;
  /** Pass null to hide Cancel (for example on a one-time secret step). */
  cancelLabel?: ReactNode | null;
  /** "destructive" fills the primary in danger, for confirmations. */
  tone?: "default" | "destructive";
  onSubmit?: (event: FormEvent<HTMLFormElement>) => SubmitResult | Promise<SubmitResult>;
  /** Called after a successful submit. */
  onSubmitted?: () => void;
  onCancel?: () => void;
  /** Controlled submitting state. Defaults to tracking `onSubmit`'s promise. */
  pending?: boolean;
  onPendingChange?: (pending: boolean) => void;
  /** A server error, rendered inside the form above the footer. */
  error?: ReactNode;
  submitDisabled?: boolean;
  /** Why the primary is disabled, shown in the footer: who can fix it. */
  disabledReason?: ReactNode;
  /** Quiet content at the start of the footer, for example "Runs with your connected accounts." */
  footerStart?: ReactNode;
  /** Replaces the Cancel and primary buttons entirely. */
  footer?: ReactNode;
  /** Close button in the header (dialog and sheet). Default true. */
  showClose?: boolean;
  /** Back link above the title (page only). */
  back?: { label: ReactNode; href?: string; onClick?: () => void };
  /** What gets focus when an overlay opens: the first field (default) or Cancel. */
  initialFocus?: "field" | "cancel";
  /** The current values are loading (an edit form): fields show as placeholders. */
  loading?: boolean;
  /** How many field placeholders to show while loading. Default 3. */
  loadingFields?: number;
  className?: string;
  bodyClassName?: string;
}

/** What went wrong and what to do; an API error's status and reference go behind Technical details. */
function errorMessage(error: unknown): ReactNode {
  const facts = apiErrorTechnicalFacts(error);
  if (facts.length === 0) return userErrorTextWithoutReference(error);
  return (
    <>
      {userErrorTextWithoutReference(error)}
      <div className="mt-1">
        <TechnicalDetails facts={facts} />
      </div>
    </>
  );
}

const SUBMITTABLE =
  "input:not([type=hidden]):not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly])";

/** First focusable field in a form body, for initial focus and after a failed submit. */
export function firstFormField(root: ParentNode | null, invalidOnly = false): HTMLElement | null {
  if (!root) return null;
  const explicit = root.querySelector<HTMLElement>("[data-autofocus]");
  if (!invalidOnly && explicit) return explicit;
  const selector = invalidOnly
    ? '[aria-invalid="true"]'
    : `${SUBMITTABLE}, select:not(:disabled), [role="radiogroup"] [tabindex="0"]`;
  return root.querySelector<HTMLElement>(selector);
}

export function FormFrame({
  variant = "dialog",
  title,
  description,
  leading,
  headerAside,
  children,
  submitLabel,
  pendingLabel,
  submitAnalyticsAction,
  cancelLabel = "Cancel",
  tone = "default",
  onSubmit,
  onSubmitted,
  onCancel,
  pending: pendingProp,
  onPendingChange,
  error,
  submitDisabled = false,
  disabledReason,
  footerStart,
  footer,
  showClose = true,
  back,
  initialFocus = "field",
  loading = false,
  loadingFields = 3,
  className,
  bodyClassName,
}: FormFrameProps) {
  const chrome = useContext(FormChromeContext);
  const [internalPending, setInternalPending] = useState(false);
  const [thrown, setThrown] = useState<ReactNode>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const pending = pendingProp ?? internalPending;
  const shownError = error ?? thrown;

  const setPending = useCallback(
    (next: boolean) => {
      setInternalPending(next);
      onPendingChange?.(next);
    },
    [onPendingChange],
  );

  const focusInvalid = () => {
    requestAnimationFrame(() => firstFormField(bodyRef.current, true)?.focus());
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || submitDisabled) return;
    setThrown(null);
    if (!onSubmit) {
      onSubmitted?.();
      return;
    }
    let succeeded = false;
    setPending(true);
    try {
      const result = await onSubmit(event);
      succeeded = result !== false;
    } catch (caught) {
      setThrown(errorMessage(caught));
    } finally {
      setPending(false);
    }
    if (succeeded) onSubmitted?.();
    else focusInvalid();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      event.target instanceof HTMLTextAreaElement
    ) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  const Title = chrome?.Title ?? (variant === "page" ? "h1" : "h2");
  const Description = chrome?.Description ?? "p";
  const Close = chrome?.Close ?? null;
  const overlay = variant === "dialog" || variant === "sheet";

  const closeButton =
    overlay && showClose ? (
      Close ? (
        <Close asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            disabled={pending}
            className="shrink-0 text-fg-muted hover:text-fg pointer-coarse:size-11"
          >
            <XIcon />
          </Button>
        </Close>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          disabled={pending}
          onClick={onCancel}
          className="shrink-0 text-fg-muted hover:text-fg pointer-coarse:size-11"
        >
          <XIcon />
        </Button>
      )
    ) : null;

  const reason = submitDisabled && disabledReason && !pending ? disabledReason : null;

  const actions = footer ?? (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        variant !== "inline" &&
          "@max-[26rem]/form:w-full @max-[26rem]/form:flex-col-reverse @max-[26rem]/form:items-stretch",
      )}
    >
      {cancelLabel !== null ? (
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
          data-autofocus={initialFocus === "cancel" ? true : undefined}
          className="pointer-coarse:h-11"
        >
          {cancelLabel}
        </Button>
      ) : null}
      <Button
        type="submit"
        data-analytics-action={submitAnalyticsAction ?? undefined}
        variant={tone === "destructive" ? "destructive" : "default"}
        // Busy is not disabled: the primary keeps its colour and its focus while
        // the spinner runs (a disabled button drops focus to the page), and a
        // second press is ignored by the submit handler.
        disabled={submitDisabled || loading}
        aria-disabled={pending || undefined}
        aria-describedby={reason ? reasonId : undefined}
        className={cn("pointer-coarse:h-11", pending && "cursor-progress")}
      >
        {pending ? (
          <>
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
            {pendingLabel ?? submitLabel}
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </div>
  );

  const start = reason ? (
    <p id={reasonId} className="flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted">
      <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{reason}</span>
    </p>
  ) : footerStart ? (
    <div className="min-w-0 text-xs leading-4.5 text-fg-muted">{footerStart}</div>
  ) : null;

  const errorBlock = shownError ? (
    <div role="alert" className="min-w-0">
      <Notice tone="failed">{shownError}</Notice>
    </div>
  ) : null;

  return (
    <div
      data-slot="form-frame"
      data-variant={variant}
      className={cn(
        "@container/form flex min-h-0 min-w-0 flex-col text-fg",
        variant === "dialog" &&
          "rounded-2xl border border-border bg-surface shadow-[var(--og-shadow-lg)]",
        variant === "sheet" && "h-full bg-surface",
        variant === "page" && "bg-bg",
        variant === "inline" && "rounded-lg border border-border bg-surface",
        className,
      )}
    >
      <form
        noValidate
        aria-busy={pending || undefined}
        onSubmit={(event) => void handleSubmit(event)}
        onKeyDown={handleKeyDown}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {variant === "page" ? (
          // The 640px column starts where a DetailPage's content starts (the
          // same 960px frame and padding), so moving between an object's page
          // and its edit page doesn't shift the back link or the title.
          <header className={cn(PAGE_FRAME, "pt-6 [&>*]:max-w-[640px]")}>
            {back ? (
              back.href ? (
                <a
                  href={back.href}
                  onClick={back.onClick}
                  className="mb-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
                >
                  <ArrowLeftIcon aria-hidden="true" className="size-4" />
                  {back.label}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={back.onClick}
                  className="mb-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
                >
                  <ArrowLeftIcon aria-hidden="true" className="size-4" />
                  {back.label}
                </button>
              )
            ) : null}
            <div className="flex min-w-0 items-start justify-between gap-4 border-b border-border pb-4">
              <div className="min-w-0">
                {/* Focusable from script only: a form page opened in place moves focus here. */}
                <Title
                  tabIndex={-1}
                  className="text-xl font-semibold tracking-[-0.5px] text-fg outline-none"
                >
                  {title}
                </Title>
                {description ? (
                  <Description className="mt-1 text-sm text-fg-muted">{description}</Description>
                ) : null}
              </div>
              {headerAside ? <div className="shrink-0">{headerAside}</div> : null}
            </div>
          </header>
        ) : (
          <header
            className={cn(
              "flex min-w-0 shrink-0 items-start gap-3",
              variant === "dialog" && "px-6 pt-5 pb-4 @max-[26rem]/form:px-5",
              variant === "sheet" && "border-b border-border px-6 py-5 @max-[26rem]/form:px-5",
              variant === "inline" && "px-5 pt-4 pb-5",
            )}
          >
            {leading && variant !== "inline" ? <div className="shrink-0">{leading}</div> : null}
            <div className={cn("min-w-0 flex-1", variant !== "inline" && "pt-1")}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Title
                  className={cn(
                    "min-w-0 font-semibold break-words text-fg",
                    variant === "inline" ? "text-sm" : "text-lg leading-6.5 tracking-[-0.25px]",
                  )}
                >
                  {title}
                </Title>
                {headerAside}
              </div>
              {description ? (
                <Description
                  className={cn(
                    "mt-1 text-fg-muted",
                    variant === "inline" ? "text-xs leading-4.5" : "text-sm",
                  )}
                >
                  {description}
                </Description>
              ) : null}
            </div>
            {closeButton ? <div className="-mt-0.5 -mr-2">{closeButton}</div> : null}
          </header>
        )}

        <div
          ref={bodyRef}
          data-slot="form-body"
          className={cn(
            "min-h-0 min-w-0",
            variant === "dialog" && "flex-1 overflow-y-auto px-6 pt-1 pb-6 @max-[26rem]/form:px-5",
            variant === "sheet" && "flex-1 overflow-y-auto px-6 py-6 @max-[26rem]/form:px-5",
            variant === "page" && cn(PAGE_FRAME, "flex-1 py-6 [&>*]:max-w-[640px]"),
            variant === "inline" && "px-5 pb-5",
            bodyClassName,
          )}
        >
          <div className={cn("min-w-0", variant === "inline" && "max-w-[560px]")}>
            {loading ? <FieldPlaceholders count={loadingFields} /> : children}
            {errorBlock ? <div className={cn(children ? "mt-6" : null)}>{errorBlock}</div> : null}
          </div>
        </div>

        <footer
          className={cn(
            "flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-3 border-t border-border",
            (variant === "dialog" || variant === "sheet") &&
              "px-6 py-4 @max-[26rem]/form:flex-col @max-[26rem]/form:items-stretch @max-[26rem]/form:px-5 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]",
            variant === "page" && "sticky bottom-0 z-10 bg-bg",
            variant === "inline" && "px-5 py-3",
          )}
        >
          {variant === "page" ? (
            <div className={cn(PAGE_FRAME, "py-4")}>
              <div className="flex w-full max-w-[640px] flex-wrap items-center justify-end gap-x-4 gap-y-3 @max-[26rem]/form:flex-col @max-[26rem]/form:items-stretch">
                {start ? (
                  <div className="min-w-0 flex-1 basis-48 @max-[26rem]/form:flex-none @max-[26rem]/form:basis-auto">
                    {start}
                  </div>
                ) : null}
                {actions}
              </div>
            </div>
          ) : variant === "inline" ? (
            // The buttons end where the field column ends, not at the panel edge.
            <div className="flex w-full max-w-[560px] flex-wrap items-center justify-end gap-x-4 gap-y-3 mr-auto">
              {start ? <div className="min-w-0 flex-1 basis-48">{start}</div> : null}
              {actions}
            </div>
          ) : (
            <>
              {start ? (
                <div className="min-w-0 flex-1 basis-48 @max-[26rem]/form:flex-none @max-[26rem]/form:basis-auto">
                  {start}
                </div>
              ) : null}
              {actions}
            </>
          )}
        </footer>
      </form>
    </div>
  );
}

/** Label and control placeholders, the shape of the fields that are loading. */
function FieldPlaceholders({ count }: { count: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex min-w-0 flex-col gap-6">
      {Array.from({ length: count }, (_, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- fixed placeholders, never reordered
        <div key={index} aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className={cn("h-4 bg-surface-2", index % 2 ? "w-20" : "w-28")} />
          <Skeleton className="h-9 rounded-md bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   FormDialog: the frame in a modal. 4 fields or fewer; use FormSheet for more.
   -------------------------------------------------------------------------- */

const DIALOG_WIDTH: Record<FormDialogSize, string> = {
  sm: "sm:max-w-[480px]",
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[640px]",
};

export interface FormOverlayProps extends Omit<FormFrameProps, "variant" | "onCancel"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional trigger element, rendered with Radix `asChild`. */
  trigger?: ReactNode;
  /**
   * When false, only Cancel, Close or Escape close it. Use it on a step that
   * shows something once (a new API key). Outside clicks never discard typed
   * input either way.
   */
  dismissible?: boolean;
  onCancel?: () => void;
  /**
   * Where focus goes after closing. Defaults to the trigger, or to whatever
   * had focus when it opened (a button, or the ⋯ that owned a menu item).
   */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Where focus goes back to after an overlay opened from state closes: what had
 * focus when it opened, or, for a menu item (which closes with its menu), the
 * button that opened the menu.
 */
function focusReturnTarget(
  active: Element | null,
  content: HTMLElement | null,
): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body || content?.contains(active)) {
    return null;
  }
  const menu = active.closest<HTMLElement>('[role="menu"]');
  const menuButtonId = menu?.getAttribute("aria-labelledby");
  const menuButton = menuButtonId ? document.getElementById(menuButtonId) : null;
  return menuButton ?? active;
}

/** Shared open/close rules for FormDialog and FormSheet. */
export function useFormOverlay({
  open,
  onOpenChange,
  dismissible = true,
  pending,
  onSubmitted,
  onCancel,
  onPendingChange,
  onCloseAutoFocus,
  hasTrigger = false,
}: Pick<
  FormOverlayProps,
  | "open"
  | "onOpenChange"
  | "dismissible"
  | "pending"
  | "onSubmitted"
  | "onCancel"
  | "onPendingChange"
  | "onCloseAutoFocus"
> & { hasTrigger?: boolean }) {
  const pendingRef = useRef(false);
  if (pending !== undefined) pendingRef.current = pending;
  const dirtyRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) dirtyRef.current = false;
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next && pendingRef.current) return;
    onOpenChange(next);
  };

  return {
    contentRef,
    rootProps: { open, onOpenChange: handleOpenChange },
    contentProps: {
      ref: contentRef,
      onInput: () => {
        dirtyRef.current = true;
      },
      onOpenAutoFocus: (event: Event) => {
        const content = contentRef.current;
        // Radix only returns focus to a Trigger. Opened from state (a button,
        // a row menu), remember what had focus so closing goes back there.
        returnFocusRef.current = focusReturnTarget(document.activeElement, content);
        const target =
          content?.querySelector<HTMLElement>("[data-autofocus]") ??
          firstFormField(content?.querySelector('[data-slot="form-body"]') ?? null);
        if (!target) return;
        event.preventDefault();
        target.focus();
      },
      onPointerDownOutside: (event: Event) => {
        if (!dismissible || pendingRef.current || dirtyRef.current) event.preventDefault();
      },
      onEscapeKeyDown: (event: Event) => {
        if (pendingRef.current) event.preventDefault();
      },
      onCloseAutoFocus: (event: Event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented || hasTrigger) return;
        const target = returnFocusRef.current;
        returnFocusRef.current = null;
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
      },
    },
    frameProps: {
      onPendingChange: (next: boolean) => {
        pendingRef.current = next;
        onPendingChange?.(next);
      },
      onSubmitted: onSubmitted ?? (() => onOpenChange(false)),
      onCancel: onCancel ?? (() => onOpenChange(false)),
    },
  };
}

export function FormDialog({
  open,
  onOpenChange,
  trigger,
  size = "md",
  dismissible,
  onCloseAutoFocus,
  onSubmitted,
  onCancel,
  onPendingChange,
  className,
  ...frame
}: FormOverlayProps & { size?: FormDialogSize }) {
  const overlay = useFormOverlay({
    open,
    onOpenChange,
    dismissible,
    pending: frame.pending,
    onSubmitted,
    onCancel,
    onPendingChange,
    onCloseAutoFocus,
    hasTrigger: Boolean(trigger),
  });
  return (
    <DialogPrimitive.Root {...overlay.rootProps}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-[120ms] starting:opacity-0" />
        <DialogPrimitive.Content
          {...overlay.contentProps}
          {...(frame.description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed z-50 flex flex-col outline-none transition-opacity duration-[120ms] starting:opacity-0",
            "inset-x-0 bottom-0 max-h-[92dvh]",
            "sm:inset-x-auto sm:bottom-auto sm:top-[12vh] sm:left-1/2 sm:max-h-[76vh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2",
            DIALOG_WIDTH[size],
          )}
        >
          <FormChromeContext.Provider value={DIALOG_CHROME}>
            <SectionFrameReset>
              <FormFrame
                variant="dialog"
                {...frame}
                {...overlay.frameProps}
                className={cn("flex-1 max-sm:rounded-b-none max-sm:border-b-0", className)}
              />
            </SectionFrameReset>
          </FormChromeContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ----------------------------------------------------------------------------
   FormPage and FormInline: the same frame without an overlay.
   -------------------------------------------------------------------------- */

/** A full-page create form, for example /schedules/new. The footer sticks to the bottom. */
export function FormPage(props: Omit<FormFrameProps, "variant">) {
  return <FormFrame variant="page" {...props} />;
}

/** A form panel in the page flow. Keep it for one or two fields next to what they change. */
export function FormInline(props: Omit<FormFrameProps, "variant" | "leading" | "back">) {
  return <FormFrame variant="inline" showClose={false} {...props} />;
}
