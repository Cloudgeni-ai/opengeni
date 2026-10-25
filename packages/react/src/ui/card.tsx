import * as React from "react";

import { cn } from "../lib/cn";

const Card = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function Card({ className, ...props }, ref) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

const CardHeader = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function CardHeader({ className, ...props }, ref) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

const CardTitle = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function CardTitle({ className, ...props }, ref) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      ref={ref}
      {...props}
    />
  );
});

const CardDescription = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function CardDescription({ className, ...props }, ref) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      ref={ref}
      {...props}
    />
  );
});

const CardAction = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function CardAction({ className, ...props }, ref) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      ref={ref}
      {...props}
    />
  );
});

const CardContent = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function CardContent({ className, ...props }, ref) {
  return <div data-slot="card-content" className={cn("px-6", className)} ref={ref} {...props} />;
});

const CardFooter = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function CardFooter({ className, ...props }, ref) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      ref={ref}
      {...props}
    />
  );
});

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
