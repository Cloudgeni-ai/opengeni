import { MoreHorizontalIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   The two action shapes of settings and detail pages: the ⋯ menu and the
   outlined row button. 44px on coarse pointers.
   -------------------------------------------------------------------------- */

/** The ⋯ button and its menu. `quiet` sits in a group header; the default in a page header. */
export function MoreMenu({
  label,
  quiet = false,
  disabled,
  children,
}: {
  label: string;
  quiet?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={quiet ? "ghost" : "outline"}
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          className={cn(
            "rounded-[10px] pointer-coarse:size-11",
            quiet ? "-mr-1.5 text-fg-subtle hover:text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An outlined small button, 44px on coarse pointers, the shape every row action uses. */
export function RowButton({ children, className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("rounded-[10px] pointer-coarse:h-11", className)}
      {...props}
    >
      {children}
    </Button>
  );
}
