"use client";

import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { MENU_SURFACE_CLASS } from "./menu-styles";
import { cn } from "../lib/cn";
import { containedPortal } from "./portal-container";

const HoverCardContainedPortal = containedPortal(HoverCardPrimitive.Portal);

function HoverCard({ ...props }: React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

const HoverCardTrigger = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof HoverCardPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Trigger>
>(function HoverCardTrigger({ ...props }, ref) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" ref={ref} {...props} />;
});

const HoverCardContent = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(function HoverCardContent({ className, align = "start", sideOffset = 6, ...props }, ref) {
  return (
    <HoverCardContainedPortal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          MENU_SURFACE_CLASS,
          "z-50 w-72 origin-(--radix-hover-card-content-transform-origin) p-3 outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        ref={ref}
        {...props}
      />
    </HoverCardContainedPortal>
  );
});

export { HoverCard, HoverCardContent, HoverCardTrigger };
