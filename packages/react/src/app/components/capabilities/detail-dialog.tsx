import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";

import { DialogContent } from "../../../ui/dialog";
import { cn } from "../../lib/utils";

type CapabilityDialogContentProps = ComponentPropsWithoutRef<typeof DialogContent>;

/** Shared content-sized detail surface for connections, plugins, and skills. */
export const CapabilityDialogContent: ForwardRefExoticComponent<
  CapabilityDialogContentProps & RefAttributes<ComponentRef<typeof DialogContent>>
> = /* @__PURE__ */ forwardRef<ComponentRef<typeof DialogContent>, CapabilityDialogContentProps>(
  function CapabilityDialogContent({ className, ...props }, ref) {
    return (
      <DialogContent
        ref={ref}
        className={cn(
          "flex flex-col gap-0 overflow-hidden border-border bg-bg p-0 pb-0 sm:max-w-[42rem] sm:rounded-2xl sm:p-0 sm:pb-0",
          "motion-reduce:animate-none motion-reduce:duration-0",
          className,
        )}
        {...props}
      />
    );
  },
);
