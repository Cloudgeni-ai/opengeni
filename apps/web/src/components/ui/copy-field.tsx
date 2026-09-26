import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { useFieldControlProps } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   CopyField - a quiet mono value with a copy button, for workspace and
   organization IDs, API key prefixes and one-time tokens.

   - "inline": the value as text plus a small icon button. For rows and meta.
   - "field":  a read-only input with a labelled Copy button. For settings rows
               and the one-time token. Focusing the value selects all of it.

   Copying confirms in place for two seconds ("Copied", announced politely).
   If the clipboard is blocked, the full value is selected so it can be copied
   with the keyboard, and a message says so: under the field, or in a tooltip
   on the inline button.

   Middle truncation keeps the start and the end, which people compare. The
   full value shows whenever it fits; only when the space runs out does the
   start give way to one ellipsis before the kept end.
   -------------------------------------------------------------------------- */

export type CopyState = "idle" | "copied" | "failed";

/** Copies text; falls back to a hidden textarea when the async clipboard is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (insecure origins, denied permission).
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.append(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** "9f1c2d4e-7a3b-…-0a1b2c3d4e5f" style: keeps the start and end, which people compare. */
export function truncateMiddle(value: string, maxLength = 24): string {
  if (value.length <= maxLength || maxLength < 5) return value;
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** "⌘C" on Apple devices, "Ctrl+C" elsewhere. */
function copyShortcut(): string {
  if (typeof navigator === "undefined") return "Ctrl+C";
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘C" : "Ctrl+C";
}

/**
 * Splits a value for middle truncation: the head shrinks with an ellipsis,
 * the tail always shows. With `maxLength` the value is first shortened to it.
 */
function middleParts(value: string, maxLength: number | undefined): [string, string] | null {
  const base = maxLength === undefined ? value : truncateMiddle(value, maxLength);
  const tailLength = maxLength === undefined ? 10 : Math.floor((maxLength - 1) / 2);
  if (tailLength < 1 || base.length <= tailLength + 3) return null;
  return [base.slice(0, base.length - tailLength), base.slice(base.length - tailLength)];
}

/** Selects an element's text so it can be copied by hand. */
function selectContents(element: HTMLElement | null) {
  if (!element) return;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.select();
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Copy with a short-lived confirmation state. */
export function useCopyToClipboard({
  resetAfter = 2000,
  copy = copyText,
}: { resetAfter?: number; copy?: (text: string) => Promise<boolean> } = {}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const run = useCallback(
    async (text: string) => {
      clearTimeout(timer.current);
      const ok = await copy(text);
      setState(ok ? "copied" : "failed");
      timer.current = setTimeout(() => setState("idle"), ok ? resetAfter : resetAfter * 3);
      return ok;
    },
    [copy, resetAfter],
  );

  return { state, copy: run };
}

export function CopyField({
  value,
  display,
  label,
  variant = "inline",
  size = "sm",
  truncate = "none",
  maxLength,
  wrap = false,
  disabled = false,
  placeholder,
  onCopied,
  copy,
  previewState,
  className,
}: {
  /** The exact text that gets copied. */
  value: string;
  /** What to show instead of the value, for example a prefix "ogk_d591f5ad…". */
  display?: ReactNode;
  /** What the value is, for the button's accessible name: "workspace ID". */
  label: string;
  variant?: "inline" | "field";
  /** Inline only: "sm" for rows and meta (24px button), "md" for settings rows. */
  size?: "sm" | "md";
  /**
   * Inline only: "middle" keeps the start and the end when space runs out
   * (IDs, tokens); the full value shows whenever it fits.
   */
  truncate?: "none" | "middle";
  /** Inline, middle only: never show more than this many characters. */
  maxLength?: number;
  /** Field only: show the whole value across lines instead of scrolling. */
  wrap?: boolean;
  disabled?: boolean;
  /** Field only: shown when there is no value yet, for example "Created when you save". */
  placeholder?: string;
  onCopied?: () => void;
  /** Injectable clipboard, for tests. */
  copy?: (text: string) => Promise<boolean>;
  /** Forces a state, for documentation previews only. */
  previewState?: CopyState;
  className?: string;
}) {
  const { state: liveState, copy: run } = useCopyToClipboard(copy ? { copy } : undefined);
  const state = previewState ?? liveState;
  const fieldProps = useFieldControlProps();
  const valueRef = useRef<HTMLElement | null>(null);
  const failedId = useId();
  const shortcut = copyShortcut();
  const empty = value.length === 0;

  const handleCopy = async () => {
    const ok = await run(value);
    if (ok) onCopied?.();
    else selectContents(valueRef.current);
  };

  const buttonLabel =
    state === "copied"
      ? `Copied ${label}`
      : state === "failed"
        ? `Couldn't copy ${label}. It's selected, so press ${shortcut} to copy it.`
        : `Copy ${label}`;

  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Couldn't copy. The value is selected."
          : ""}
    </span>
  );

  if (variant === "field") {
    const valueClass = cn(
      "block w-full min-w-0 rounded-md! border border-border bg-surface-2 px-3 font-mono text-xs text-fg outline-offset-2 selection:bg-brand/25 placeholder:font-sans placeholder:text-fg-subtle focus-visible:border-brand disabled:text-fg-muted",
      wrap ? "resize-none py-2 leading-5 break-all" : "h-9 text-ellipsis pointer-coarse:h-11",
    );
    const shared = {
      readOnly: true,
      value,
      placeholder,
      spellCheck: false,
      "aria-label": fieldProps.id ? undefined : label,
      ...fieldProps,
      "aria-describedby":
        state === "failed"
          ? [fieldProps["aria-describedby"], failedId].filter(Boolean).join(" ")
          : fieldProps["aria-describedby"],
      disabled,
      onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
        event.currentTarget.select(),
    };
    return (
      <div data-slot="copy-field" data-state={state} className={cn("min-w-0", className)}>
        <div className="flex min-w-0 items-start gap-2">
          {wrap ? (
            <textarea
              ref={(node) => {
                valueRef.current = node;
              }}
              rows={1}
              {...shared}
              className={cn(valueClass, "field-sizing-content")}
            />
          ) : (
            <input
              ref={(node) => {
                valueRef.current = node;
              }}
              {...shared}
              className={valueClass}
            />
          )}
          <Button
            type="button"
            variant="outline"
            disabled={disabled || empty}
            aria-label={buttonLabel}
            onClick={() => void handleCopy()}
            className={cn(
              "h-9 min-w-22 shrink-0 pointer-coarse:h-11",
              state === "copied" && "text-status-idle hover:text-status-idle",
            )}
          >
            {state === "copied" ? (
              <CheckIcon aria-hidden="true" className="size-4" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-4" />
            )}
            {state === "copied" ? "Copied" : "Copy"}
          </Button>
        </div>
        {state === "failed" ? (
          <p id={failedId} className="mt-1.5 text-xs leading-4.5 text-danger">
            Couldn't copy. The value is selected - press {shortcut} to copy it.
          </p>
        ) : null}
        {status}
      </div>
    );
  }

  // The visible text may be shortened; screen readers and a blocked-clipboard
  // selection always get the full value.
  const parts =
    display === undefined && truncate === "middle" ? middleParts(value, maxLength) : null;
  const iconClass = size === "sm" ? "size-3.5" : "size-4";
  return (
    <span
      data-slot="copy-field"
      data-state={state}
      className={cn("inline-flex max-w-full min-w-0 items-center gap-1", className)}
    >
      {/* Line height matches the button, so the text centres on it and the
          whole field sits on the surrounding text's baseline. */}
      <span
        aria-hidden="true"
        className={cn(
          "flex min-w-0 font-mono text-xs text-fg-muted",
          size === "sm" ? "leading-6" : "leading-8",
        )}
      >
        {parts ? (
          <>
            <span className="min-w-0 truncate">{parts[0]}</span>
            <span className="shrink-0 whitespace-pre">{parts[1]}</span>
          </>
        ) : (
          <span className="min-w-0 truncate">{display ?? value}</span>
        )}
      </span>
      <span
        ref={(node) => {
          valueRef.current = node;
        }}
        className="sr-only"
      >
        {value}
      </span>
      <TooltipPrimitive.Provider delayDuration={0}>
        <TooltipPrimitive.Root open={state === "failed"}>
          <TooltipPrimitive.Trigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={size === "sm" ? "icon-xs" : "icon-sm"}
              disabled={disabled}
              aria-label={buttonLabel}
              onClick={() => void handleCopy()}
              className={cn(
                "shrink-0 text-fg-subtle hover:text-fg pointer-coarse:size-11",
                state === "copied" && "text-status-idle hover:text-status-idle",
                state === "failed" && "text-danger hover:text-danger",
              )}
            >
              {state === "copied" ? (
                <CheckIcon aria-hidden="true" className={iconClass} />
              ) : (
                <CopyIcon aria-hidden="true" className={iconClass} />
              )}
            </Button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              data-slot="copy-field-tooltip"
              side="top"
              sideOffset={6}
              collisionPadding={8}
              className="z-50 max-w-64 rounded-md bg-fg px-2.5 py-1.5 text-xs leading-4.5 text-bg shadow-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[120ms]"
            >
              Couldn't copy. Press {shortcut} to copy it.
              <TooltipPrimitive.Arrow width={10} height={5} className="fill-fg" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
      {status}
    </span>
  );
}
