import { LoaderCircleIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

/*
 * One card language for every moment the agent waits on the person: questions,
 * approvals and connect cards. A calm neutral surface, the decision as the
 * heading, one strong action, and buttons that stack full width when the card
 * is narrow (phone, side panel, small embed). The card never scrolls inside
 * itself; the conversation around it does.
 */

/** The card surface. A size container, so actions adapt to the card, not the window. */
export const decisionCardClass =
  "og-root @container/decision box-border min-w-0 w-full overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1 text-og-fg shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_20px_-12px_rgb(0_0_0/0.18)]";

/** Padding for the card's own sections. */
export const decisionCardPad = "px-4 @md/decision:px-5";

/** The small square beside the heading: an app logo or an icon. */
export function DecisionMark({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "plain" | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-og-md [&_svg]:size-[18px]",
        tone === "danger"
          ? "bg-og-status-failed/10 text-og-status-failed"
          : tone === "plain"
            ? ""
            : "bg-og-fg/[0.06] text-og-fg-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Actions row. Narrow cards stack full-width buttons with the primary on top
 * (it is the last child); wider cards put them on one line at the end.
 * A `lead` (details link, hint) sits at the start on wide cards and last on narrow ones.
 */
export function DecisionActions({
  lead,
  children,
  className,
}: {
  lead?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col-reverse gap-2 @md/decision:flex-row @md/decision:flex-wrap @md/decision:items-center @md/decision:justify-end",
        className,
      )}
    >
      {lead ? (
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 @md/decision:mr-auto @md/decision:justify-start">
          {lead}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export type DecisionButtonKind = "primary" | "danger" | "secondary" | "quiet";

const buttonKinds: Record<DecisionButtonKind, string> = {
  primary: "border-transparent bg-og-fg text-og-bg hover:bg-og-fg/85 active:bg-og-fg/75",
  danger:
    "border-transparent bg-og-danger-fill text-og-danger-fg hover:bg-og-danger-fill/90 active:bg-og-danger-fill/80",
  secondary:
    "border-og-border bg-og-surface-1 text-og-fg hover:border-og-border-strong hover:bg-og-hover active:bg-og-surface-2",
  quiet: "border-transparent text-og-fg-muted hover:bg-og-hover hover:text-og-fg",
};

/** Button classes for decision actions; full width while the card is narrow. */
export function decisionButtonClass(kind: DecisionButtonKind, className?: string): string {
  return cn(
    "inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-og-md border px-4 py-2 text-og-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-150",
    "@md/decision:min-h-9 @md/decision:w-auto pointer-coarse:min-h-11",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45 focus-visible:ring-offset-1 focus-visible:ring-offset-og-surface-1",
    "disabled:cursor-not-allowed disabled:opacity-55",
    buttonKinds[kind],
    className,
  );
}

export type DecisionButtonProps = {
  kind?: DecisionButtonKind | undefined;
  /** Shows a spinner in place; the label stays so the button keeps its width. */
  busy?: boolean | undefined;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export const DecisionButton = forwardRef<HTMLButtonElement, DecisionButtonProps>(
  function DecisionButton(
    { kind = "secondary", busy = false, className, children, type = "button", ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        // oxlint-disable-next-line react/button-has-type -- forwarded, defaults to "button"
        type={type}
        aria-busy={busy || undefined}
        className={decisionButtonClass(kind, className)}
        {...rest}
      >
        {busy ? (
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
        ) : null}
        {children}
      </button>
    );
  },
);
