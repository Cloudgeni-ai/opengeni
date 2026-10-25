"use client";

import * as React from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import {
  MENU_CHECK_CLASS,
  MENU_CHECK_SLOT_CLASS,
  MENU_CHEVRON_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_META_CLASS,
  MENU_NOTE_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from "./menu-styles";
import { cn } from "../lib/cn";
import { containedPortal } from "./portal-container";

const DropdownMenuContainedPortal = containedPortal(DropdownMenuPrimitive.Portal);

const MENU_MOTION_CLASS =
  "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

function DropdownMenu({
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuContainedPortal data-slot="dropdown-menu-portal" {...props} />;
}

const DropdownMenuTrigger = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(function DropdownMenuTrigger({ ...props }, ref) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" ref={ref} {...props} />;
});

const DropdownMenuContent = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <DropdownMenuContainedPortal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto",
          MENU_SURFACE_CLASS,
          MENU_MOTION_CLASS,
          className,
        )}
        ref={ref}
        {...props}
      />
    </DropdownMenuContainedPortal>
  );
});

const DropdownMenuGroup = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group>
>(function DropdownMenuGroup({ ...props }, ref) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" ref={ref} {...props} />;
});

const DropdownMenuItem = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>, "disabled"> & {
    disabled?: boolean | undefined;
    inset?: boolean | undefined;
    variant?: "default" | "destructive" | undefined;
  }
>(function DropdownMenuItem({ className, inset, variant = "default", disabled, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(MENU_ITEM_CLASS, "data-[inset]:pl-9", className)}
      {...(disabled === undefined ? {} : { disabled })}
      ref={ref}
      {...props}
    />
  );
});

const DropdownMenuCheckboxItem = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, checked, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MENU_ITEM_CLASS, className)}
      {...(checked === undefined ? {} : { checked })}
      ref={ref}
      {...props}
    >
      {children}
      <span data-slot="dropdown-menu-item-indicator" className={MENU_CHECK_SLOT_CLASS}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon aria-hidden="true" className={MENU_CHECK_CLASS} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
});

const DropdownMenuRadioGroup = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioGroup>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioGroup>
>(function DropdownMenuRadioGroup({ ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" ref={ref} {...props} />
  );
});

const DropdownMenuRadioItem = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>, "disabled"> & {
    disabled?: boolean | undefined;
  }
>(function DropdownMenuRadioItem({ className, children, disabled, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MENU_ITEM_CLASS, className)}
      {...(disabled === undefined ? {} : { disabled })}
      ref={ref}
      {...props}
    >
      {children}
      <span data-slot="dropdown-menu-item-indicator" className={MENU_CHECK_SLOT_CLASS}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon aria-hidden="true" className={MENU_CHECK_CLASS} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
});

const DropdownMenuLabel = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean | undefined;
  }
>(function DropdownMenuLabel({ className, inset, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(MENU_LABEL_CLASS, "data-[inset]:pl-9", className)}
      ref={ref}
      {...props}
    />
  );
});

const DropdownMenuSeparator = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR_CLASS, className)}
      ref={ref}
      {...props}
    />
  );
});

const DropdownMenuShortcut = /* @__PURE__ */ React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(function DropdownMenuShortcut({ className, ...props }, ref) {
  return (
    <span
      // The item carries the key in aria-keyshortcuts; glyphs like "⇧⌘,"
      // would only garble its accessible name.
      aria-hidden
      data-slot="dropdown-menu-shortcut"
      className={cn(MENU_META_CLASS, "tracking-widest pointer-coarse:hidden", className)}
      ref={ref}
      {...props}
    />
  );
});

function DropdownMenuSub({
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

const DropdownMenuSubTrigger = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean | undefined;
  }
>(function DropdownMenuSubTrigger({ className, inset, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(MENU_ITEM_CLASS, "data-[inset]:pl-9", className)}
      ref={ref}
      {...props}
    >
      {children}
      <ChevronRightIcon aria-hidden="true" className={cn(MENU_CHEVRON_CLASS, "ml-auto")} />
    </DropdownMenuPrimitive.SubTrigger>
  );
});

const DropdownMenuSubContent = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden",
        MENU_SURFACE_CLASS,
        MENU_MOTION_CLASS,
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

/** Right-side meta on a row: a count or the current value. */
const DropdownMenuMeta = /* @__PURE__ */ React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(function DropdownMenuMeta({ className, ...props }, ref) {
  return (
    <span
      data-slot="dropdown-menu-meta"
      className={cn(MENU_META_CLASS, className)}
      ref={ref}
      {...props}
    />
  );
});

/**
 * The selected option's check, on the right of its row. Every option of a
 * choice list renders it, so the 16px slot stays reserved and right-side meta
 * lines up whether or not the row is checked.
 */
function DropdownMenuCheck({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      data-slot="dropdown-menu-check"
      aria-hidden="true"
      className={cn(MENU_CHECK_SLOT_CLASS, className)}
    >
      {checked ? <CheckIcon className={MENU_CHECK_CLASS} /> : null}
    </span>
  );
}

/** A plain sentence in a menu (empty, loading, unavailable): said once, never boxed. */
const DropdownMenuNote = /* @__PURE__ */ React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<"p">
>(function DropdownMenuNote({ className, ...props }, ref) {
  return (
    <p
      data-slot="dropdown-menu-note"
      className={cn(MENU_NOTE_CLASS, className)}
      ref={ref}
      {...props}
    />
  );
});

export {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuMeta,
  DropdownMenuNote,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
