// The sidebar's one treatment, shared by every rail that takes the left edge of
// the app: the session rail (`SessionShell`) and the settings rail (the web
// app's `SettingsShell`). Moving between sessions and settings swaps the rail's
// contents, never its column, surface or brand row.
//
// Kept free of session state so the settings shell can use it without loading
// the session list.
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { BrandMark, Wordmark } from "../brand-mark";
import { cn } from "../../lib/utils";

/**
 * The docked rail's column beside the canvas, with a hairline on its right
 * edge. In the macOS app (`[data-shell-rail]` in the web app's styles) the
 * column is part of the window frame: the hairline is clear and the window's
 * sidebar glass shows through its surface.
 */
export function ShellRail({
  as: Element = "div",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { as?: "div" | "nav" }) {
  return (
    <Element
      data-shell-rail
      className={cn("relative shrink-0 border-r border-border", className)}
      {...props}
    />
  );
}

/**
 * The rail's surface: the rail glow over the app background, in a column as
 * tall as the rail. Docked in the macOS app it is clear, so the bar, the rail
 * and the margin around the canvas read as one sheet of glass. Nothing inside
 * a rail paints its own background over it.
 */
export function RailSurface({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-rail-surface
      className={cn(
        "og-rail-glow isolate flex h-full min-h-0 flex-col overflow-hidden pt-[env(safe-area-inset-top)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The rail's brand row: a 32px row whose empty space moves the desktop window,
 * like the window bar above it.
 */
export function RailBrandRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      data-rail-brand
      data-window-drag
      className={cn("flex h-8 min-w-0 items-center gap-2 px-2", className)}
    >
      {children}
    </div>
  );
}

/** The brand link's classes; its children are `RailBrandMark`. */
export const RAIL_BRAND_LINK_CLASS =
  "flex h-8 shrink-0 items-center gap-2 rounded-md px-1.5 text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

/** The mark and, unless the rail is collapsed, the "Opengeni" wordmark. */
export function RailBrandMark({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <>
      <BrandMark className="w-5" />
      {collapsed ? null : <Wordmark className="text-[18px]" />}
    </>
  );
}
