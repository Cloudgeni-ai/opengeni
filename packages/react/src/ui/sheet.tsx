import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";

import { SectionFrameReset } from "./section-variant";
import { cn } from "../lib/cn";
import { containedPortal } from "./portal-container";

const SheetContainedPortal = containedPortal(SheetPrimitive.Portal);

function Sheet({ ...props }: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

const SheetTrigger = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Trigger>
>(function SheetTrigger({ ...props }, ref) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" ref={ref} {...props} />;
});

const SheetClose = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Close>
>(function SheetClose({ ...props }, ref) {
  return <SheetPrimitive.Close data-slot="sheet-close" ref={ref} {...props} />;
});

function SheetPortal({ ...props }: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Portal>) {
  return <SheetContainedPortal data-slot="sheet-portal" {...props} />;
}

const SheetOverlay = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(function SheetOverlay({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

const SheetContent = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
    side?: "top" | "right" | "bottom" | "left" | undefined;
    showCloseButton?: boolean | undefined;
  }
>(function SheetContent(
  { className, children, side = "right", showCloseButton = true, ...props },
  ref,
) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-background shadow-lg transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:animate-in data-[state=open]:duration-500",
          side === "right" &&
            "inset-y-0 right-0 h-full w-3/4 max-w-[85vw] border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
          side === "left" &&
            "inset-y-0 left-0 h-full w-3/4 max-w-[85vw] border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
          side === "top" &&
            "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
          side === "bottom" &&
            "inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
          className,
        )}
        ref={ref}
        {...props}
      >
        <SectionFrameReset>{children}</SectionFrameReset>
        {showCloseButton && (
          <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-secondary">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});

const SheetHeader = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function SheetHeader({ className, ...props }, ref) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      ref={ref}
      {...props}
    />
  );
});

const SheetFooter = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function SheetFooter({ className, ...props }, ref) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      ref={ref}
      {...props}
    />
  );
});

const SheetTitle = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
      ref={ref}
      {...props}
    />
  );
});

const SheetDescription = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      ref={ref}
      {...props}
    />
  );
});

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
