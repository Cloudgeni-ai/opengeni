import { CheckIcon, ChevronRightIcon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   ErrorMessage (design brief 6 and 7, "Also build").

   What happened, then what to do. Never the raw "OpenGeni API 404 ...
   Reference: <uuid>" string: the request reference and other system facts
   live behind one collapsed "Technical details", with Copy.

   - "inline": one line inside a row, section or field group.
   - "block":  replaces the content of a section or list that failed to load.
   -------------------------------------------------------------------------- */

export interface ErrorDetail {
  label: string;
  value: string;
  /** Render mono with a Copy button (references, IDs). */
  copyable?: boolean;
}

export interface ErrorMessageProps {
  /** What happened, in product words: "Couldn't load this connection's tools." */
  title: ReactNode;
  /** What to do next, when it isn't just "Try again". */
  children?: ReactNode;
  /** Usually a small "Try again" button; for inline, a link-style button. */
  action?: ReactNode;
  /** The request reference. Goes into Technical details with Copy. */
  reference?: string;
  /** Other system facts for Technical details: status code, endpoint. */
  details?: ErrorDetail[];
  /** Start with Technical details open. */
  defaultDetailsOpen?: boolean;
  variant?: "inline" | "block";
  /** "center" for a failed list or page area, "start" inside a section. */
  align?: "start" | "center";
  /**
   * Announce it to screen readers as it appears. Use for errors caused by
   * something the person just did; leave off for errors present on load.
   */
  announce?: boolean;
  className?: string;
}

export function ErrorMessage({
  title,
  children,
  action,
  reference,
  details,
  defaultDetailsOpen = false,
  variant = "block",
  align = "start",
  announce = false,
  className,
}: ErrorMessageProps) {
  const facts: ErrorDetail[] = [
    ...(details ?? []),
    ...(reference ? [{ label: "Reference", value: reference, copyable: true }] : []),
  ];
  const role = announce ? "alert" : undefined;

  if (variant === "inline") {
    return (
      <div
        role={role}
        data-slot="error-message"
        data-variant="inline"
        className={cn("flex min-w-0 flex-col gap-1", className)}
      >
        <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-fg">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="min-w-0">
            {title}
            {children ? <span className="text-fg-muted"> {children}</span> : null}
            {/* A plain space, not a margin, so a wrapped action lines up with the text. */}
            {action ? (
              <>
                {" "}
                <span className="inline-flex align-baseline whitespace-nowrap">{action}</span>
              </>
            ) : null}
          </span>
        </p>
        {facts.length > 0 ? (
          <div className="pl-6">
            <TechnicalDetails facts={facts} defaultOpen={defaultDetailsOpen} />
          </div>
        ) : null}
      </div>
    );
  }

  const centered = align === "center";
  return (
    <div
      role={role}
      data-slot="error-message"
      data-variant="block"
      className={cn(
        "flex min-w-0 flex-col",
        centered ? "items-center py-10 text-center" : "items-start",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md border border-danger/25 bg-danger/10 text-danger",
          "mb-3",
        )}
      >
        <CircleAlertIcon className="size-4" />
      </span>
      <p className="text-sm leading-5 font-medium text-fg">{title}</p>
      {children ? (
        <p
          className={cn(
            "mt-1 text-xs leading-4.5 text-fg-muted",
            centered && "max-w-[48ch] text-balance",
          )}
        >
          {children}
        </p>
      ) : null}
      {action ? <div className="mt-3 flex flex-wrap items-center gap-2">{action}</div> : null}
      {facts.length > 0 ? (
        <div className={cn("mt-3 w-full", centered && "flex max-w-sm flex-col items-center")}>
          <TechnicalDetails facts={facts} align={align} defaultOpen={defaultDetailsOpen} />
        </div>
      ) : null}
    </div>
  );
}

/** The one collapsed "Technical details" line, with Copy on references. */
export function TechnicalDetails({
  facts,
  align = "start",
  defaultOpen = false,
}: {
  facts: ErrorDetail[];
  align?: "start" | "center";
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className={cn("min-w-0", align === "center" && "flex flex-col items-center")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-fg-subtle transition-colors duration-[120ms] hover:text-fg pointer-coarse:h-11"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-[120ms] motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Technical details
      </button>
      <dl
        id={panelId}
        hidden={!open}
        className={cn(
          "mt-1 grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-left text-xs leading-4.5",
        )}
      >
        {facts.map((fact) => (
          <div key={fact.label} className="col-span-2 grid grid-cols-subgrid items-center">
            <dt className="text-fg-subtle">{fact.label}</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "min-w-0",
                  fact.copyable
                    ? "font-mono wrap-anywhere text-fg"
                    : "wrap-break-word text-fg-muted",
                )}
              >
                {fact.value}
              </span>
              {fact.copyable ? <CopyButton value={fact.value} label={fact.label} /> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false),
        );
      }}
      className="inline-grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-3 hover:text-fg pointer-coarse:size-11"
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5 text-status-idle" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
