"use client";

import { ChevronRightIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { containedPortal } from "../ui/portal-container";
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";
import { cn } from "../lib/cn";
import { useMergedRefs } from "../lib/refs";
import {
  MENU_CHEVRON_CLASS,
  MENU_ITEM_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from "../lib/menu-styles";

const MENU_MOTION_CLASS =
  "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
import { usePortalTokenSource, usePortalTokenStyle } from "../lib/use-portal-token-style";

const DropdownMenuContainedPortal = containedPortal(DropdownMenuPrimitive.Portal);

type DropdownMenuSourceContextValue = {
  source: HTMLElement | null;
  ref: (node: HTMLElement | null) => void;
};

const DropdownMenuSourceContext = createContext<DropdownMenuSourceContextValue | null>(null);

function DropdownMenu(props: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>) {
  const source = usePortalTokenSource<HTMLElement>();
  return (
    <DropdownMenuSourceContext.Provider value={source}>
      <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
    </DropdownMenuSourceContext.Provider>
  );
}

const DropdownMenuTrigger = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(function DropdownMenuTrigger(props, forwardedRef) {
  const sourceRef = useContext(DropdownMenuSourceContext);
  const ref = useMergedRefs<HTMLButtonElement>(sourceRef?.ref, forwardedRef);
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" ref={ref} {...props} />;
});

const DropdownMenuContent = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, style, ...props }, ref) {
  const source = useContext(DropdownMenuSourceContext);
  const portalStyle = usePortalTokenStyle(source?.source ?? null);
  return (
    <DropdownMenuContainedPortal>
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
        ref={ref}
        {...props}
      />
    </DropdownMenuContainedPortal>
  );
});

const DropdownMenuItem = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: "default" | "destructive";
  }
>(function DropdownMenuItem({ className, inset, variant = "default", ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(MENU_ITEM_CLASS, "data-[inset]:pl-9", className)}
      ref={ref}
      {...props}
    />
  );
});

const DropdownMenuSeparator = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
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

function DropdownMenuSub(props: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

const DropdownMenuSubTrigger = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }
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

const DropdownMenuSubContent = /* @__PURE__ */ forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, style, ...props }, ref) {
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
      ref={ref}
      {...props}
    />
  );
});

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
