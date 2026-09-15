import { ChevronDownIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select"> & { displayValue?: string }
>(
  ({ className, children, displayValue, ...props }, ref) => (
    <span className="relative inline-block max-w-full">
      <select
        ref={ref}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-border bg-bg px-2.5 pr-8 text-sm text-fg transition-colors hover:border-border-strong focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
          displayValue !== undefined && "text-transparent [&_option]:text-fg [&_optgroup]:text-fg",
        )}
        {...props}
      >
        {children}
      </select>
      {displayValue !== undefined ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-2.5 right-8 flex min-w-0 items-center text-sm text-fg",
            props.disabled && "opacity-50",
          )}
        >
          <span className="truncate">{displayValue}</span>
        </span>
      ) : null}
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
      />
    </span>
  ),
);
Select.displayName = "Select";

export { Select };
