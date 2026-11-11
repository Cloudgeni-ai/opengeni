import type { ReactNode } from "react";
import { Button } from "../../../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../ui/tooltip";

/**
 * Where a sidebar row's quick actions sit: over the row's last metadata slots
 * (time and status), which RailTrailingMetadata hides while the row is hovered
 * or holds focus, so the title column never moves. Touch keeps the row's
 * overflow menu instead.
 */
export const RAIL_ROW_QUICK_ACTIONS_CLASS =
  "absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:hidden [&>button]:w-6 [&>button:last-child]:w-10";

/** The overflow trigger touch and other coarse pointers get in its place. */
export const RAIL_ROW_OVERFLOW_TRIGGER_CLASS =
  "absolute right-0 top-1/2 z-10 hidden size-11 -translate-y-1/2 bg-surface-2 text-fg-subtle hover:text-fg pointer-coarse:inline-flex";

/** One icon button in a row's quick actions, named and with a tooltip. */
export function RailRowQuickAction({
  label,
  tooltip = label,
  onActivate,
  children,
  ...data
}: {
  /** The accessible name. A toggle names its next action ("Unpin"), so it
   * carries no aria-pressed, which would announce the state twice. */
  label: string;
  /** The visible tooltip; the label when omitted. */
  tooltip?: string | undefined;
  onActivate: () => void;
  children: ReactNode;
} & { [attribute: `data-${string}`]: string | undefined }) {
  return (
    // Its own provider so a row rendered outside the app shell still works.
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            {...data}
            onClick={(event) => {
              // The button sits inside the row; never also open the row.
              event.preventDefault();
              event.stopPropagation();
              onActivate();
            }}
            className="text-fg-subtle hover:text-fg"
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
