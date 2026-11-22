import { MoreHorizontalIcon } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
} from "react";

import { Button } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu";
import { cn } from "../lib/cn";

/* ----------------------------------------------------------------------------
   The two action shapes of settings and detail pages: the ⋯ menu and the
   outlined row button. 44px on coarse pointers.
   -------------------------------------------------------------------------- */

/** The ⋯ button and its menu. `quiet` sits in a group header; the default in a page header. */
export function MoreMenu({
  label,
  quiet = false,
  disabled,
  onCloseAutoFocus,
  children,
}: {
  label: string;
  quiet?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * As the menu closes it returns focus to its button; call `preventDefault`
   * when the chosen item focuses something else (an inline rename field).
   */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
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
      <DropdownMenuContent align="end" className="min-w-48" onCloseAutoFocus={onCloseAutoFocus}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An outlined small button, 44px on coarse pointers, the shape every row action uses. */
export const RowButton = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof Button>,
  ComponentPropsWithoutRef<typeof Button>
>(function RowButton({ children, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className={cn("rounded-[10px] pointer-coarse:h-11", className)}
      {...props}
    >
      {children}
    </Button>
  );
});
