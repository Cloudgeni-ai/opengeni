import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One shell for composer drill-ins, regardless of the kind of resource. */
export const COMPOSER_MENU_PANEL_CLASS =
  "flex w-[min(24rem,calc(100vw-1.5rem))] max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl border-border bg-surface p-2 shadow-md";

export const COMPOSER_MENU_ACTION_CLASS =
  "min-h-11 cursor-pointer gap-3 rounded-md px-2 py-2 text-sm";

export function ComposerMenuHeader(props: {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2 pb-2">
      {props.leading}
      <h2 className="min-w-0 flex-1 text-sm font-medium">{props.title}</h2>
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
        "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
        checked ? "bg-brand" : "bg-fg-subtle/35",
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-3",
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