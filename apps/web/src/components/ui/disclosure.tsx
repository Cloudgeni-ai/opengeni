import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, LockIcon } from "lucide-react";
import { useCallback, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DetailBody,
  DetailFooter,
  DetailHeader,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
  DetailSheetTrigger,
} from "@/components/ui/detail-sheet";
import { SheetClose } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * - `row` (default): a full-width row with a left chevron that turns 90°, the
 *   title and a summary of the current values. Opens in place.
 * - `inline`: summary on the left, "Change" / "Hide" and a chevron on the right,
 *   between two hairlines. Opens in place.
 * - `sheet`: nothing opens in place. The row has a right chevron (it opens
 *   something) and the options live in a DetailSheet.
 */
export type DisclosureVariant = "row" | "inline" | "sheet";

export interface DisclosureProps {
  variant?: DisclosureVariant;
  /** "Advanced", "Technical details". */
  title: ReactNode;
  /** The current values, so people know what is inside before opening it. */
  summary?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Why it can't be opened and who can change that. Replaces the summary. */
  disabledReason?: ReactNode;
  /**
   * Something inside needs attention: "Data notebooks was deleted. Choose
   * where it runs." Replaces the summary, so a closed section never hides an
   * error.
   */
  error?: ReactNode;
  /** The summary is still loading. */
  loading?: boolean;
  /** Sheet variant: the sheet's title. Defaults to `title`. */
  sheetTitle?: ReactNode;
  /** Sheet variant: one line under the sheet's title, usually the object's name. */
  sheetDescription?: ReactNode;
  /** Sheet variant: footer actions. Defaults to one "Done" button. */
  sheetFooter?: ReactNode;
  className?: string;
  /** Classes on the row that opens it. */
  triggerClassName?: string;
  /** Classes on the revealed content. */
  contentClassName?: string;
  children: ReactNode;
}

function useOpenState(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
) {
  const [inner, setInner] = useState(defaultOpen ?? false);
  const controlled = open !== undefined;
  const current = controlled ? open : inner;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  return [current, setOpen] as const;
}

/**
 * The line under (or next to) the title: the summary, or what blocks it or
 * needs attention. `clampClassName` limits only the summary text; an error or
 * a reason always shows in full.
 */
function SummaryLine({
  id,
  summary,
  disabled,
  disabledReason,
  error,
  loading,
  className,
  clampClassName = "line-clamp-2",
}: {
  id: string;
  summary?: ReactNode;
  disabled?: boolean;
  disabledReason?: ReactNode;
  error?: ReactNode;
  loading?: boolean;
  className?: string;
  clampClassName?: string;
}) {
  if (error) {
    return (
      <span
        id={id}
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger",
          className,
        )}
      >
        <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{error}</span>
      </span>
    );
  }
  if (disabled && disabledReason) {
    return (
      <span
        id={id}
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted",
          className,
        )}
      >
        <LockIcon className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span className="min-w-0">{disabledReason}</span>
      </span>
    );
  }
  if (loading) {
    return (
      <span id={id} className={cn("flex h-4.5 min-w-0 items-center", className)}>
        <span className="sr-only">Loading</span>
        <span
          aria-hidden="true"
          className="h-2.5 w-48 max-w-full animate-pulse rounded-full bg-surface-3 motion-reduce:animate-none"
        />
      </span>
    );
  }
  if (!summary) return null;
  return (
    <span id={id} className={cn("block min-w-0 text-xs leading-4.5 text-fg-muted", className)}>
      <span className={clampClassName}>{summary}</span>
    </span>
  );
}

/**
 * Hides secondary options of the same object, one level only. Never nest one
 * inside another, never put the primary action inside, and never use it for
 * a sheet's main content.
 */
export function Disclosure({
  variant = "row",
  title,
  summary,
  open: openProp,
  defaultOpen,
  onOpenChange,
  disabled,
  disabledReason,
  error,
  loading,
  sheetTitle,
  sheetDescription,
  sheetFooter,
  className,
  triggerClassName,
  contentClassName,
  children,
}: DisclosureProps) {
  const [open, setOpen] = useOpenState(openProp, defaultOpen, onOpenChange);
  const summaryId = useId();
  const contentId = useId();
  const hasLine = Boolean(error || (disabled && disabledReason) || loading || summary);
  const line = (lineClassName?: string, clampClassName?: string) =>
    hasLine ? (
      <SummaryLine
        id={summaryId}
        summary={summary}
        disabled={disabled}
        disabledReason={disabledReason}
        error={error}
        loading={loading}
        className={lineClassName}
        clampClassName={clampClassName}
      />
    ) : null;

  if (variant === "sheet") {
    return (
      <DetailSheet open={open} onOpenChange={setOpen}>
        <div
          data-slot="disclosure"
          data-variant="sheet"
          data-disabled={disabled ? "" : undefined}
          className={cn("group/disclosure min-w-0", className)}
        >
          <DetailSheetTrigger asChild disabled={disabled}>
            <button
              type="button"
              aria-describedby={hasLine ? summaryId : undefined}
              className={cn(
                "-mx-2 flex min-h-11 w-[calc(100%+1rem)] min-w-0 items-center gap-3 rounded-[10px] px-2 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2 disabled:cursor-not-allowed disabled:hover:bg-transparent",
                triggerClassName,
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-fg group-data-[disabled]/disclosure:text-fg-muted">
                  {title}
                </span>
                {line()}
              </span>
              {disabled ? null : (
                <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
              )}
            </button>
          </DetailSheetTrigger>
        </div>
        <DetailSheetContent {...(sheetDescription ? {} : { "aria-describedby": undefined })}>
          <DetailHeader title={sheetTitle ?? title} subtitle={sheetDescription} />
          <DetailBody>
            <DetailSection className={contentClassName}>{children}</DetailSection>
          </DetailBody>
          <DetailFooter>
            {sheetFooter ?? (
              <SheetClose asChild>
                <Button type="button" className="pointer-coarse:h-11">
                  Done
                </Button>
              </SheetClose>
            )}
          </DetailFooter>
        </DetailSheetContent>
      </DetailSheet>
    );
  }

  if (variant === "inline") {
    return (
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
        data-slot="disclosure"
        data-variant="inline"
        className={cn("group/disclosure min-w-0 border-y border-border", className)}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-controls={contentId}
            aria-describedby={hasLine && !open ? summaryId : undefined}
            className={cn(
              // The row reaches 8px past the text on both sides, so the focus
              // ring (drawn inside it) never touches the hairlines or the text.
              "group/trigger -mx-2 flex min-h-11 w-[calc(100%+1rem)] min-w-0 items-center justify-between gap-4 rounded-[10px] px-2 py-2.5 text-left focus-visible:-outline-offset-2 disabled:cursor-not-allowed",
              triggerClassName,
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg group-data-[disabled]/disclosure:text-fg-muted">
                {title}
              </span>
              {line("mt-0.5 group-data-[state=open]/disclosure:hidden")}
            </span>
            {disabled ? null : (
              <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-brand underline-offset-4 group-hover/trigger:underline">
                {open ? "Hide" : "Change"}
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-4 transition-transform duration-[120ms] group-data-[state=open]/disclosure:rotate-180 motion-reduce:transition-none"
                />
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent
          forceMount
          id={contentId}
          className={cn("pt-3 pb-5 data-[state=closed]:hidden", contentClassName)}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      data-slot="disclosure"
      data-variant="row"
      className={cn("group/disclosure @container min-w-0", className)}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-controls={contentId}
          aria-describedby={hasLine && !open ? summaryId : undefined}
          className={cn(
            "-mx-2 flex min-h-11 w-[calc(100%+1rem)] min-w-0 items-start gap-2 rounded-[10px] px-2 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2 disabled:cursor-not-allowed disabled:hover:bg-transparent",
            triggerClassName,
          )}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-data-[state=open]/disclosure:rotate-90 group-data-[disabled]/disclosure:text-border-strong motion-reduce:transition-none"
          />
          {/* At 480px and wider the summary sits on the title's line; its 2px
              top offset puts the 12px baseline on the 14px title's baseline. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 @min-[480px]:flex-row @min-[480px]:items-start @min-[480px]:gap-3">
            <span className="shrink-0 text-sm font-medium text-fg group-data-[disabled]/disclosure:text-fg-muted">
              {title}
            </span>
            {line(
              "flex-1 group-data-[state=open]/disclosure:hidden @min-[480px]:mt-0.5",
              "line-clamp-2 @min-[480px]:line-clamp-1",
            )}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount
        id={contentId}
        className={cn("pt-2 pb-2 pl-6 data-[state=closed]:hidden", contentClassName)}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
