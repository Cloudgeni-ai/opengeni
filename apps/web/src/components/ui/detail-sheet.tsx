import {
  createContext,
  useContext,
  useId,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { LogoTileSizeProvider } from "@/components/ui/logo-tile";
import { SECTION_TITLE_CLASS } from "@/components/ui/section";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   DetailSheet, DetailPage and DetailInline (design brief 7.5) - the single
   place to manage one thing: anything with more than one control or its own
   sub-list. One anatomy in three presentations:

   - DetailSheet   (A, default) 520px right sheet, sections, sticky opaque
                   footer, full screen on phones. Keeps the list in view. For
                   accounts, people, keys and schedules.
   - DetailPage    (B, default for objects with their own tables) a
                   deep-linkable page. For variable sets and environments.
   - DetailInline  (C) expand in place under a list row. Only for one level
                   of secondary options (see ListRow `expanded`).

   The parts are shared: DetailHeader (tile, 18/600 title, subtitle, status,
   ⋯), DetailBody with borderless DetailSections split by hairlines, facts as
   label/value rows (DetailFacts, 12px label, 14px value) and DetailFooter
   (destructive ghost left, Cancel/Done and the primary right).
   Keep the sheet URL-addressable (`?account=<id>`) at the call site.
   -------------------------------------------------------------------------- */

export type DetailPresentation = "sheet" | "preview" | "page" | "inline";

const PresentationContext = createContext<DetailPresentation>("preview");

function usePresentation(): DetailPresentation {
  return useContext(PresentationContext);
}

/** Where the enclosing detail view is shown. */
export function useDetailPresentation(): DetailPresentation {
  return usePresentation();
}

/* ----------------------------------------------------------------------------
   A. The sheet.
   -------------------------------------------------------------------------- */

/** The sheet root. Control it with `open` and `onOpenChange` (tie it to the URL). */
export function DetailSheet(props: ComponentProps<typeof Sheet>) {
  return <Sheet {...props} />;
}

export const DetailSheetTrigger = SheetTrigger;

const SHEET_PANEL =
  "flex min-h-0 min-w-0 flex-col bg-surface text-fg shadow-[var(--og-shadow-lg)] @container/detail";

export interface DetailSheetContentProps extends Omit<
  ComponentProps<typeof DialogPrimitive.Content>,
  "children"
> {
  children: ReactNode;
}

/**
 * The 520px right sheet: full height, full screen on phones, slides in over
 * 200ms (reduced motion skips it). Children are a DetailHeader, a DetailBody
 * and an optional DetailFooter. Pass `aria-describedby={undefined}` when the
 * header has no subtitle.
 */
export function DetailSheetContent({
  children,
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: DetailSheetContentProps) {
  // Sheets usually open from a list row, not a DetailSheetTrigger, so Radix
  // has nothing to return focus to. Remember what had focus as the sheet
  // opened (the row) and go back there on close.
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="detail-sheet-overlay"
        className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 starting:opacity-0"
      />
      <DialogPrimitive.Content
        data-slot="detail-sheet"
        {...props}
        onOpenAutoFocus={(event) => {
          // Focus hasn't moved yet: this is still the row that opened the sheet.
          const active = document.activeElement;
          returnTo.current =
            active instanceof HTMLElement && active !== document.body ? active : null;
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // Land on the sheet itself: screen readers hear its title and
          // description, and no control lights up before anyone asks.
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const target = returnTo.current;
          returnTo.current = null;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
        className={cn(
          SHEET_PANEL,
          "fixed inset-y-0 right-0 z-50 h-full w-full border-border outline-none sm:w-[520px] sm:max-w-[calc(100vw-2rem)] sm:border-l",
          "transition-transform duration-200 ease-out starting:translate-x-full",
          className,
        )}
      >
        <PresentationContext.Provider value="sheet">{children}</PresentationContext.Provider>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * The same sheet panel without the overlay, in the page flow. For docs,
 * previews and screenshots; `onClose` wires the header's close button.
 */
export function DetailSheetPreview({
  children,
  label,
  onClose,
  className,
}: {
  children: ReactNode;
  /** Accessible name of the region, usually the object's name. */
  label: string;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <section
      data-slot="detail-sheet"
      data-preview=""
      aria-label={label}
      className={cn(SHEET_PANEL, "w-full max-w-[520px] border-l border-border", className)}
    >
      <PreviewCloseContext.Provider value={onClose ?? null}>
        <PresentationContext.Provider value="preview">{children}</PresentationContext.Provider>
      </PreviewCloseContext.Provider>
    </section>
  );
}

const PreviewCloseContext = createContext<(() => void) | null>(null);

/* ----------------------------------------------------------------------------
   B. The page, and C. inline.
   -------------------------------------------------------------------------- */

export interface DetailBackLink {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}

/** A deep-linkable detail page on the standard 960px column. */
export function DetailPage({
  back,
  children,
  className,
}: {
  /** "Variable sets": the list this page belongs to. */
  back?: DetailBackLink;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="detail-page"
      className={cn(
        "@container/detail mx-auto flex w-full max-w-[960px] min-w-0 flex-col px-8 pt-6 pb-12 max-sm:px-4",
        className,
      )}
    >
      {back ? <BackLink back={back} /> : null}
      <PresentationContext.Provider value="page">{children}</PresentationContext.Provider>
    </div>
  );
}

function BackLink({ back }: { back: DetailBackLink }) {
  const className =
    "mb-4 inline-flex w-fit items-center gap-1.5 rounded-[6px] text-sm leading-5 font-medium text-fg-muted transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11";
  const content = (
    <>
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      {back.label}
    </>
  );
  return back.href ? (
    <a href={back.href} onClick={back.onClick} className={className}>
      {content}
    </a>
  ) : (
    <button type="button" onClick={back.onClick} className={className}>
      {content}
    </button>
  );
}

/**
 * Detail expanded in place under a list row. Pass it as a ListRow `panel`.
 * Keep it to one level of secondary options; anything larger is a sheet.
 */
export function DetailInline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="detail-inline"
      className={cn(
        "@container/detail min-w-0 rounded-[14px] border border-border bg-surface",
        className,
      )}
    >
      <PresentationContext.Provider value="inline">{children}</PresentationContext.Provider>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Shared parts.
   -------------------------------------------------------------------------- */

export interface DetailHeaderProps {
  /** A 40px LogoTile or avatar. Sheet and page. */
  leading?: ReactNode;
  title: ReactNode;
  /** One line under the title: "ChatGPT Pro · Workspace". */
  subtitle?: ReactNode;
  /** A StatusBadge (and role chips) next to the title. */
  status?: ReactNode;
  /** A ⋯ menu, or a page's primary action. */
  actions?: ReactNode;
  /** Show the sheet's close button. Default true. */
  showClose?: boolean;
  className?: string;
}

export function DetailHeader({
  leading,
  title,
  subtitle,
  status,
  actions,
  showClose = true,
  className,
}: DetailHeaderProps) {
  const presentation = usePresentation();
  const previewClose = useContext(PreviewCloseContext);
  const inDialog = presentation === "sheet";
  const Title = inDialog ? SheetTitle : presentation === "page" ? "h1" : "h2";
  const Description = inDialog ? SheetDescription : "p";

  if (presentation === "page") {
    return (
      <header
        data-slot="detail-header"
        className={cn(
          "flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-4 border-b border-border pb-4",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {leading ? <LogoTileSizeProvider size="lg">{leading}</LogoTileSizeProvider> : null}
          <div className={cn("min-w-0 flex-1", leading && "pt-1.5")}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Title className="min-w-0 text-xl leading-7 font-semibold tracking-[-0.5px] break-words text-fg">
                {title}
              </Title>
              {status}
            </div>
            {subtitle ? (
              <Description className="mt-1 text-sm leading-5 text-fg-muted">{subtitle}</Description>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
    );
  }

  if (presentation === "inline") {
    return (
      <header
        data-slot="detail-header"
        className={cn("flex min-w-0 items-start justify-between gap-4 px-4 pt-4", className)}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Title className="text-sm leading-5 font-semibold text-fg">{title}</Title>
            {status}
          </div>
          {subtitle ? (
            <Description className="mt-0.5 text-xs leading-4.5 text-fg-muted">
              {subtitle}
            </Description>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
    );
  }

  const closeButtonClass = "shrink-0 text-fg-muted hover:text-fg pointer-coarse:size-11";
  const close = !showClose ? null : inDialog ? (
    <SheetClose asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        className={closeButtonClass}
      >
        <XIcon />
      </Button>
    </SheetClose>
  ) : previewClose ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close"
      onClick={previewClose}
      className={closeButtonClass}
    >
      <XIcon />
    </Button>
  ) : null;

  return (
    <header
      data-slot="detail-header"
      className={cn(
        "flex min-w-0 shrink-0 items-start gap-3 border-b border-border px-6 py-5 max-sm:px-5",
        className,
      )}
    >
      {leading ? (
        <div className="shrink-0">
          <LogoTileSizeProvider size="lg">{leading}</LogoTileSizeProvider>
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Title className="min-w-0 text-lg leading-6.5 font-semibold tracking-[-0.25px] break-words text-fg">
            {title}
          </Title>
          {status}
        </div>
        {subtitle ? (
          <Description className="mt-0.5 text-sm leading-5 text-fg-muted">{subtitle}</Description>
        ) : null}
      </div>
      {actions || close ? (
        <div className="-mt-0.5 -mr-2 flex shrink-0 items-center gap-0.5">
          {actions}
          {close}
        </div>
      ) : null}
    </header>
  );
}

/** The scrolling body. Sections inside are split by hairlines. */
export function DetailBody({ children, className }: { children: ReactNode; className?: string }) {
  const presentation = usePresentation();
  return (
    <div
      data-slot="detail-body"
      className={cn(
        "flex min-w-0 flex-col divide-y divide-border",
        (presentation === "sheet" || presentation === "preview") &&
          "min-h-0 flex-1 overflow-y-auto px-6 max-sm:px-5",
        presentation === "page" && "pt-2",
        presentation === "inline" && "px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface DetailSectionProps {
  title?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** A small action, vertically centred with the title: "Edit", "Add variable". */
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * A borderless section: the 16/600 section title (14/600 inline), 12px
 * description, content 12px below.
 */
export function DetailSection({
  title,
  description,
  action,
  children,
  className,
}: DetailSectionProps) {
  const presentation = usePresentation();
  const headingId = useId();
  const Heading = presentation === "page" ? "h2" : "h3";
  const spacing = presentation === "inline" ? "py-4" : presentation === "page" ? "py-8" : "py-6";
  return (
    <section
      data-slot="detail-section"
      aria-labelledby={title ? headingId : undefined}
      className={cn("min-w-0", spacing, className)}
    >
      {title || action ? (
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <Heading
                id={headingId}
                className={
                  presentation === "inline"
                    ? "text-sm leading-5 font-semibold text-fg"
                    : SECTION_TITLE_CLASS
                }
              >
                {title}
              </Heading>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs leading-4.5 text-fg-muted">{description}</p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {children ? <div className={cn(title || action ? "mt-3" : null)}>{children}</div> : null}
    </section>
  );
}

/** Facts as label/value rows. Stacks under 440px of width. */
export function DetailFacts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("m-0 grid min-w-0 gap-y-3", className)}>{children}</dl>;
}

export function DetailFact({
  label,
  children,
  action,
}: {
  label: ReactNode;
  children: ReactNode;
  /** One small control at the end of the row: "Rename", "Edit". */
  action?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 @[440px]/detail:grid-cols-[148px_minmax(0,1fr)_auto]">
      <dt className="col-start-1 text-xs leading-5 text-fg-muted">{label}</dt>
      <dd className="col-start-1 m-0 min-w-0 text-sm leading-5 break-words text-fg @[440px]/detail:col-start-2 @[440px]/detail:row-start-1">
        {children}
      </dd>
      {action ? (
        <div className="col-start-2 row-span-2 row-start-1 self-center @[440px]/detail:col-start-3 @[440px]/detail:row-span-1">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function footerFrame(presentation: DetailPresentation): string {
  return cn(
    "border-t border-border",
    (presentation === "sheet" || presentation === "preview") &&
      "mt-auto bg-surface px-6 py-4 max-sm:px-5 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]",
    presentation === "page" && "py-6",
    presentation === "inline" && "px-4 py-3",
  );
}

/**
 * The footer. In a sheet it is sticky and opaque: the destructive action as a
 * ghost on the left (`start`), Cancel or Done and the one primary on the right.
 */
export function DetailFooter({
  start,
  children,
  className,
}: {
  /** The quiet destructive action, or a short status line. */
  start?: ReactNode;
  /** Cancel or Done, then the primary. */
  children?: ReactNode;
  className?: string;
}) {
  const presentation = usePresentation();
  return (
    <footer
      data-slot="detail-footer"
      className={cn(
        "flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2",
        footerFrame(presentation),
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{start}</div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </footer>
  );
}

export interface DetailFooterConfirmProps {
  /** The question with the real name: "Disconnect ops@acme.dev?" */
  title: ReactNode;
  /** The real consequence, one or two short sentences. */
  description?: ReactNode;
  /** Verb + object, or the bare verb: "Disconnect". */
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
  /** The action is running: both buttons disable and the label can change. */
  pending?: boolean;
  className?: string;
}

/**
 * The footer turned into a quick confirm for a destructive action on the
 * object itself (Disconnect, Revoke): the question with the real name, the
 * consequence, then Cancel and the destructive button. Anything with
 * dependencies to review, or that can't be undone for other people, uses the
 * destructive confirm dialog instead.
 */
export function DetailFooterConfirm({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  pending = false,
  className,
}: DetailFooterConfirmProps) {
  const presentation = usePresentation();
  const titleId = useId();
  const descriptionId = useId();
  // The question reads first, full width; the buttons sit under it on the
  // right, where Done and the primary normally are.
  return (
    <footer
      data-slot="detail-footer"
      data-confirm=""
      role="group"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("flex min-w-0 shrink-0 flex-col gap-3", footerFrame(presentation), className)}
    >
      <div className="min-w-0">
        <p id={titleId} className="m-0 text-sm leading-5 font-medium break-words text-fg">
          {title}
        </p>
        {description ? (
          <p id={descriptionId} className="m-0 mt-0.5 text-xs leading-4.5 text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={pending}
          // The safe choice takes focus when the question appears in a real sheet.
          autoFocus={presentation === "sheet"}
          className="pointer-coarse:h-11"
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={onConfirm}
          disabled={pending}
          className="pointer-coarse:h-11"
        >
          {confirmLabel}
        </Button>
      </div>
    </footer>
  );
}

/** Loading placeholder with the header and fact rows in place. */
export function DetailSkeleton({ sections = 2 }: { sections?: number }) {
  const presentation = usePresentation();
  const padded = presentation === "sheet" || presentation === "preview";
  return (
    <div role="status" aria-label="Loading details" className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex shrink-0 items-start gap-3",
          padded ? "border-b border-border px-6 py-5 max-sm:px-5" : "pb-4",
        )}
      >
        <Skeleton className="size-10 shrink-0 rounded-[10px] bg-surface-2" />
        <div className="min-w-0 flex-1 pt-1">
          <Skeleton className="h-4 w-2/5 rounded-full bg-surface-2" />
          <Skeleton className="mt-2.5 h-3 w-3/5 rounded-full bg-surface-2" />
        </div>
      </div>
      <div className={cn("flex flex-col divide-y divide-border", padded && "px-6 max-sm:px-5")}>
        {Array.from({ length: sections }, (_, section) => (
          // oxlint-disable-next-line react/no-array-index-key -- identical placeholders
          <div key={section} className="py-6">
            <Skeleton className="h-3.5 w-24 rounded-full bg-surface-2" />
            <div className="mt-4 grid gap-3">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-4">
                  <Skeleton className="h-3 w-28 shrink-0 rounded-full bg-surface-2" />
                  <Skeleton
                    className={cn("h-3 rounded-full bg-surface-2", row === 1 ? "w-1/3" : "w-1/2")}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
