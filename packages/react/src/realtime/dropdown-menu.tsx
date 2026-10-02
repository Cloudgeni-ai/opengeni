"use client";

import { ChevronRightIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { createContext, useContext, type ComponentProps, type Ref } from "react";
import { cn } from "../lib/cn";
import {
  MENU_CHEVRON_CLASS,
  MENU_ITEM_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from "../lib/menu-styles";

const MENU_MOTION_CLASS =
  "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
import { usePortalTokenSource, usePortalTokenStyle } from "../lib/use-portal-token-style";

type DropdownMenuSourceContextValue = {
  source: HTMLElement | null;
  ref: (node: HTMLElement | null) => void;
};

const DropdownMenuSourceContext = createContext<DropdownMenuSourceContextValue | null>(null);

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function DropdownMenu(props: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const source = usePortalTokenSource<HTMLElement>();
  return (
    <DropdownMenuSourceContext.Provider value={source}>
      <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
    </DropdownMenuSourceContext.Provider>
  );
}

function DropdownMenuTrigger({
  ref,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const sourceRef = useContext(DropdownMenuSourceContext);
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      ref={(node) => {
        sourceRef?.ref(node);
        assignRef(ref, node);
      }}
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  style,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const source = useContext(DropdownMenuSourceContext);
  const portalStyle = usePortalTokenStyle(source?.source ?? null);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "og-root z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto",
          MENU_SURFACE_CLASS,
          MENU_MOTION_CLASS,
          className,
        )}
        style={{ ...portalStyle, ...style }}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & {
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

function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR_CLASS, className)}
      {...props}
    />
  );
}

function DropdownMenuSub(props: ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
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
  style,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const source = useContext(DropdownMenuSourceContext);
  const portalStyle = usePortalTokenStyle(source?.source ?? null);
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "og-root z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden",
        MENU_SURFACE_CLASS,
        MENU_MOTION_CLASS,
        className,
      )}
      style={{ ...portalStyle, ...style }}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
