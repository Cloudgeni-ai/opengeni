"use client";

import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import {
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_META_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from "./menu-styles";
import { cn } from "../lib/cn";
import { containedPortal } from "./portal-container";

const ContextMenuContainedPortal = containedPortal(ContextMenuPrimitive.Portal);

// A thin radix ContextMenu wrapper on the one menu spec (menu-styles.ts), so
// the rail row's right-click menu reads identically to the app's other menus.
// Only the pieces the rename surface needs are wrapped; extend as needed.

function ContextMenu({
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

const ContextMenuTrigger = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>(function ContextMenuTrigger({ ...props }, ref) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" ref={ref} {...props} />;
});

const ContextMenuContent = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextMenuContent({ className, ...props }, ref) {
  return (
    <ContextMenuContainedPortal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          "z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          MENU_SURFACE_CLASS,
          className,
        )}
        ref={ref}
        {...props}
      />
    </ContextMenuContainedPortal>
  );
});

const ContextMenuItem = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean | undefined;
    variant?: "default" | "destructive" | undefined;
  }
>(function ContextMenuItem({ className, inset, variant = "default", ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(MENU_ITEM_CLASS, "data-[inset]:pl-9", className)}
      ref={ref}
      {...props}
    />
  );
});

const ContextMenuSeparator = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(function ContextMenuSeparator({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(MENU_SEPARATOR_CLASS, className)}
      ref={ref}
      {...props}
    />
  );
});

const ContextMenuLabel = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean | undefined;
  }
>(function ContextMenuLabel({ className, inset, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(MENU_LABEL_CLASS, "data-[inset]:pl-9", className)}
      ref={ref}
      {...props}
    />
  );
});

/** An item's key on the right, like `DropdownMenuShortcut`. */
const ContextMenuShortcut = /* @__PURE__ */ React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(function ContextMenuShortcut({ className, ...props }, ref) {
  return (
    <span
      // The item carries the key in aria-keyshortcuts; glyphs like "⇧⌘,"
      // would only garble its accessible name.
      aria-hidden
      data-slot="context-menu-shortcut"
      className={cn(MENU_META_CLASS, "tracking-widest pointer-coarse:hidden", className)}
      ref={ref}
      {...props}
    />
  );
});

export {
  ContextMenu,
  ContextMenuShortcut,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
};
