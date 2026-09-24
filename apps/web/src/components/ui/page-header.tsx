import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Standard page header shared with the Capabilities catalog. */
export function PageHeader(props: {
  icon?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between",
        props.className,
      )}
    >
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          {props.icon ? <span className="text-brand">{props.icon}</span> : null}
          {props.title}
        </h1>
        {props.description ? (
          <p className="mt-1 text-sm leading-5 text-fg-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{props.actions}</div>
      ) : null}
    </div>
  );
}
