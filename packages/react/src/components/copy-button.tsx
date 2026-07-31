import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { copyTextToClipboard } from "../lib/clipboard";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

const COPIED_MS = 1600;

export type CopyButtonProps = {
  /** Plain text to copy, or a lazy getter (tables / late DOM). */
  text: string | (() => string);
  /** Accessible name + tooltip while idle. */
  label?: string | undefined;
  className?: string | undefined;
  /**
   * `always` — visible control.
   * `group-hover` — parent must use `group/copy`; fades in on hover/focus.
   */
  reveal?: "always" | "group-hover" | undefined;
};

/**
 * Ghost icon copy control — no chrome box, no "Copy code" label.
 * Copy → check flash. Hover-reveal via `group/copy` on a parent.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
  reveal = "group-hover",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const onClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const value = typeof text === "function" ? text() : text;
    const ok = await copyTextToClipboard(value);
    if (!ok) {
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, COPIED_MS);
  };

  const tip = copied ? "Copied" : label;

  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-og-copy=""
            data-state={copied ? "copied" : "idle"}
            aria-label={tip}
            onClick={onClick}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-og-sm",
              "text-og-fg-subtle transition-[opacity,color,background-color] duration-150",
              "hover:bg-og-surface-2/80 hover:text-og-fg",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent/40",
              reveal === "group-hover" &&
                "opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 pointer-coarse:opacity-70",
              copied && "opacity-100 text-og-accent",
              className,
            )}
          >
            {copied ? (
              <CheckIcon className="size-3.5" aria-hidden />
            ) : (
              <CopyIcon className="size-3.5" aria-hidden />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Hover-reveal chrome around a message / turn so {@link CopyButton} can fade in. */
export function CopyHoverFrame({
  children,
  className,
  copyText,
  label,
  align = "end",
}: {
  children: ReactNode;
  className?: string | undefined;
  copyText: string;
  label: string;
  align?: "start" | "end" | undefined;
}) {
  if (copyText.trim().length === 0) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div className={cn("group/copy relative", className)}>
      {children}
      <div
        className={cn(
          "pointer-events-none absolute top-1 z-10",
          align === "end" ? "right-1" : "left-1",
        )}
      >
        <div className="pointer-events-auto">
          <CopyButton text={copyText} label={label} reveal="group-hover" />
        </div>
      </div>
    </div>
  );
}
