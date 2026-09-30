import { ChevronLeftIcon } from "lucide-react";
import { lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";

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

/**
 * Rows still loading inside a composer menu: the same height as the rows they
 * stand for, so the menu opens at its final size and nothing jumps when they
 * arrive. Never a "Loading…" sentence inside an action menu.
 */
export function ComposerMenuRowsSkeleton({
  rows = 3,
  label,
  size = "row",
}: {
  rows?: number;
  /** Announced to screen readers ("Loading connectors"). */
  label: string;
  /** `row`: 32px menu rows; `tile`: 56px rows with a tile and a second line. */
  size?: "row" | "tile";
}) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className={cn(
            "flex items-center gap-3 px-2.5",
            size === "tile" ? "min-h-14 py-1.5" : "h-8",
          )}
        >
          <span
            className={cn(
              "shrink-0 animate-pulse bg-surface-2",
              size === "tile" ? "size-8 rounded-lg" : "size-4 rounded",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              className="h-2.5 animate-pulse rounded bg-surface-2"
              style={{ width: `${[58, 44, 66, 50][index % 4]}%` }}
            />
            {size === "tile" ? (
              <span className="h-2 w-1/3 animate-pulse rounded bg-surface-2" />
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

const composerMenuPreloads = new Set<() => Promise<unknown>>();

/**
 * A composer drill-in whose body loads on demand registers its loader here.
 * Registering loads nothing; the composer warms every registered drill-in
 * when "+" is hovered, focused or idle, so opening one never waits on code.
 */
export function registerComposerMenuPreload(load: () => Promise<unknown>): void {
  composerMenuPreloads.add(load);
}

export function preloadComposerMenuPanels(): void {
  for (const load of composerMenuPreloads) void load().catch(() => undefined);
}

/**
 * `React.lazy` that renders straight away once its code is loaded. Plain lazy
 * suspends for a frame on its first render even when the module is already
 * cached, which flashes the loading rows and resizes the menu. The loader is
 * registered as a composer drill-in preload. Keep a Suspense boundary around
 * it for the cold case.
 */
export function lazyComposerPanel<P extends object>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  const loadOnce = () =>
    load().then((component) => {
      loaded = component;
      return component;
    });
  const Lazy = lazy(() => loadOnce().then((component) => ({ default: component })));
  registerComposerMenuPreload(loadOnce);
  function ComposerPanel(props: P) {
    // Decided once per mount, so a panel never swaps implementations while open.
    const [Ready] = useState<ComponentType<P> | null>(() => loaded);
    const Component = (Ready ?? Lazy) as ComponentType<P>;
    return <Component {...props} />;
  }
  return ComposerPanel;
}
