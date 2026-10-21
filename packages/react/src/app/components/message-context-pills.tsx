// The page's labeled message context (such as the selection in an open
// workbook) as pills above the composer. The person can leave one out of their
// messages and bring it back; a new label brings it back by itself.
import { PlusIcon, TextSelectIcon, XIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import { useMessageContextPills } from "../lib/app-host";
import { cn } from "../../lib/cn";

export function MessageContextPills() {
  const { pills, exclude, include } = useMessageContextPills();
  if (pills.length === 0) return null;
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex flex-wrap gap-1.5 px-3.5 pt-2.5 md:px-4"
        role="group"
        aria-label="Context sent with your message"
      >
        {pills.map((pill) => {
          const description = pill.excluded
            ? `Not sent with your messages: ${pill.label}`
            : `Sent with your messages${pill.detail ? `: ${pill.detail}` : ""}`;
          return (
            <span
              key={pill.id}
              data-excluded={pill.excluded || undefined}
              className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-1 rounded-og-md border py-0.5 pr-0.5 pl-1.5 text-og-sm transition-colors",
                pill.excluded
                  ? "border-dashed border-og-border bg-transparent text-og-fg-subtle"
                  : "border-og-border bg-og-surface-2 text-og-fg-muted",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex min-w-0 items-center gap-1" tabIndex={0}>
                    <TextSelectIcon className="size-3 shrink-0" aria-hidden />
                    <span className={cn("truncate", pill.excluded && "line-through")}>
                      {pill.label}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{description}</TooltipContent>
              </Tooltip>
              <button
                type="button"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-og-sm hover:bg-og-surface-3 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent"
                onClick={() => (pill.excluded ? include(pill.id) : exclude(pill.id))}
                aria-label={pill.excluded ? `Send ${pill.label} again` : `Don't send ${pill.label}`}
              >
                {pill.excluded ? <PlusIcon className="size-3" /> : <XIcon className="size-3" />}
              </button>
            </span>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
