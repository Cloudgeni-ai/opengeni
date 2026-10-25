import * as React from "react";

import { cn } from "../lib/cn";

const Skeleton = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function Skeleton({ className, ...props }, ref) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      ref={ref}
      {...props}
    />
  );
});

export { Skeleton };
