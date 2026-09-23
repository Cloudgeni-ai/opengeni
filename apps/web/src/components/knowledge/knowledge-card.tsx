import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One keyboard-accessible target for an entire file, collection, or entry. */
export function KnowledgeCard(props: {
  title: string;
  description?: string;
  icon: ReactNode;
  metadata: ReactNode;
  variant?: "entry" | "collection" | "file";
  onClick: () => void;
}) {
  const variant = props.variant ?? "entry";
  return (
    <button
      type="button"
      aria-label={props.title}
      onClick={props.onClick}
      className={cn(
        "group flex h-full w-full min-w-0 gap-4 rounded-xl border border-border/70 p-5 text-left transition-colors hover:border-fg-subtle/40 hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        variant === "entry" ? "items-start bg-bg" : "flex-col bg-surface/50",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg",
          variant === "collection"
            ? "size-10 bg-brand/10 text-brand"
            : variant === "file"
              ? "size-12 bg-surface-2 text-fg-muted"
              : "mt-0.5 size-8 text-fg-subtle",
        )}
      >
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 break-words text-sm font-medium text-fg">
            {props.title}
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
        </span>
        {props.description ? (
          <span className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm leading-6 text-fg-muted">
            {props.description}
          </span>
        ) : null}
        <span
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-xs text-fg-subtle",
            variant === "entry" ? "mt-0" : "mt-auto",
          )}
        >
          {props.metadata}
        </span>
      </span>
    </button>
  );
}
