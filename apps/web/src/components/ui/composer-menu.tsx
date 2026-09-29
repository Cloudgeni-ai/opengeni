import { ChevronLeftIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import {
  MENU_BACK_BUTTON_CLASS,
  MENU_BACK_HEADER_CLASS,
  MENU_SURFACE_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";

/**
 * One shell for the composer "+" menu and its drill-ins, regardless of the
 * kind of resource: the app's one menu surface at a fixed width.
 */
export const COMPOSER_MENU_PANEL_CLASS = cn(
  "flex w-[min(24rem,calc(100vw-1.5rem))] max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden",
  MENU_SURFACE_CLASS,
);

/** The back control of every drill-in header. */
export function MenuBackButton({
  label = "Back",
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(MENU_BACK_BUTTON_CLASS, className)}
      {...props}
    >
      <ChevronLeftIcon aria-hidden="true" className="size-4" />
    </button>
  );
}

/** A drill-in's header: back, the submenu's title, optional trailing control. */
export function ComposerMenuHeader(props: {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn(MENU_BACK_HEADER_CLASS, !props.leading && "pl-2.5")}>
      {props.leading}
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{props.title}</h2>
      {props.trailing}
    </div>
  );
}

/** Visual-only form for a row that already owns the accessible toggle action. */
export function ComposerMenuSwitchIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-4 w-7 shrink-0 items-center rounded-full border p-px transition-colors",
        checked ? "border-primary-border bg-primary" : "border-transparent bg-switch-track",
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full shadow-sm transition-transform",
          checked ? "translate-x-3 bg-primary-foreground" : "bg-switch-thumb",
        )}
      />
    </span>
  );
}

export function ComposerMenuSwitch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  locked?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      aria-disabled={props.locked || props.disabled || undefined}
      disabled={props.disabled}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-end rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11",
        props.locked ? "cursor-default" : "cursor-pointer",
        props.className,
      )}
      onClick={() => {
        if (!props.disabled && !props.locked) props.onCheckedChange(!props.checked);
      }}
    >
      <ComposerMenuSwitchIndicator checked={props.checked} />
    </button>
  );
}
