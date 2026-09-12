import type { ComponentProps } from "react";

import { DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Shared content-sized detail surface for connections, plugins, and skills. */
export function CapabilityDialogContent({
  className,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn(
        "flex flex-col gap-0 overflow-hidden border-border bg-bg p-0 pb-0 sm:max-w-[42rem] sm:rounded-2xl sm:p-0 sm:pb-0",
        "motion-reduce:animate-none motion-reduce:duration-0",
        className,
      )}
      {...props}
    />
  );
}
