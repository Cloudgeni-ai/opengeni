import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Shared compact form section for secondary settings. The closed state keeps
 * the effective value visible; the open state is intentionally borderless so
 * forms do not accumulate nested cards.
 */
export function FormDisclosure(props: {
  title: string;
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full min-w-0 items-center justify-between gap-4 border-y border-border py-3 text-left hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg">{props.title}</span>
            <span className="mt-0.5 block truncate text-xs text-fg-subtle">{props.summary}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
            {props.open ? "Hide" : "Change"}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-4 transition-transform", props.open && "rotate-180")}
            />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 border-b border-border py-4">{props.children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
