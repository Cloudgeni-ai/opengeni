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
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";

const MENU_MOTION_CLASS =
  "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto",
          MENU_SURFACE_CLASS,
          MENU_MOTION_CLASS,
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(MENU_ITEM_CLASS, "data-[inset]:pl-9", className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MENU_ITEM_CLASS, className)}
      checked={checked}
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
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MENU_ITEM_CLASS, className)}
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
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(MENU_LABEL_CLASS, "data-[inset]:pl-9", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR_CLASS, className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(MENU_META_CLASS, "tracking-widest", className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(MENU_ITEM_CLASS, "data-[inset]:pl-9", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon aria-hidden="true" className={cn(MENU_CHEVRON_CLASS, "ml-auto")} />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden",
        MENU_SURFACE_CLASS,
        MENU_MOTION_CLASS,
        className,
      )}
      {...props}
    />
  );
}

/** Right-side meta on a row: a count or the current value. */
function DropdownMenuMeta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="dropdown-menu-meta" className={cn(MENU_META_CLASS, className)} {...props} />
  );
}

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
function DropdownMenuNote({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="dropdown-menu-note" className={cn(MENU_NOTE_CLASS, className)} {...props} />;
}

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
