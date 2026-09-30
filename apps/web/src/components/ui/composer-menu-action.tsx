import type { ReactNode } from "react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * One action row for composer drill-ins, as a menu item inside the + menu and
 * as a button when the same panel is shown in a dialog. Kept apart from the
 * lazily loaded connector list so the + menu can use it without loading that.
 */
export function ConnectorAction(props: {
  presentation?: "menu" | "dialog";
  checked?: boolean;
  label?: string;
  disabled?: boolean;
  /**
   * Reachable with the keyboard and read as unavailable, but does nothing: a
   * current value shown in a menu (Radix skips `disabled` items entirely).
   */
  readOnly?: boolean;
  locked?: boolean;
  className?: string;
  keepOpen?: boolean;
  onAction: () => void;
  children: ReactNode;
}) {
  if (props.readOnly) {
    return props.presentation === "dialog" ? (
      <button
        type="button"
        aria-label={props.label}
        aria-disabled="true"
        className={cn(
          "flex w-full cursor-default items-center gap-2 px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          props.className,
        )}
        onClick={(event) => event.preventDefault()}
      >
        {props.children}
      </button>
    ) : (
      <DropdownMenuItem
        aria-label={props.label}
        aria-disabled="true"
        className={cn("cursor-default", props.className)}
        onSelect={(event) => event.preventDefault()}
      >
        {props.children}
      </DropdownMenuItem>
    );
  }
  if (props.locked) {
    return (
      <div
        aria-label={props.label}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
          props.className,
        )}
      >
        {props.children}
      </div>
    );
  }
  if (props.presentation === "dialog") {
    return (
      <button
        type="button"
        role={props.checked === undefined ? undefined : "switch"}
        aria-label={props.label}
        aria-checked={props.checked}
        aria-disabled={props.disabled || undefined}
        disabled={props.disabled}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          props.className,
        )}
        onClick={props.onAction}
      >
        {props.children}
      </button>
    );
  }
  return (
    <DropdownMenuItem
      role={props.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-label={props.label}
      aria-checked={props.checked}
      aria-disabled={props.disabled || undefined}
      disabled={props.disabled}
      className={props.className}
      onSelect={(event) => {
        if (props.keepOpen) event.preventDefault();
        props.onAction();
      }}
    >
      {props.children}
    </DropdownMenuItem>
  );
}
