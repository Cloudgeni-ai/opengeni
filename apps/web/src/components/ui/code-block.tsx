import { CheckIcon, CopyIcon } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";

import { RowButton } from "@/components/ui/page-actions";
import { useCopyToClipboard } from "@/components/ui/copy-field";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   CodeBlock: a command or a short snippet to copy and run.

   One header row (a label, or a control such as language tabs, on the left;
   Copy on the right) over the code, in mono 12/18. Long lines scroll inside
   the block, never the page; `wrap` breaks them instead (shell commands).
   Copy falls back to selecting the code when the clipboard is blocked (plain
   http origins), and says so.
   -------------------------------------------------------------------------- */

export function CodeBlock({
  code,
  label,
  header,
  wrap = false,
  onCopied,
  copyLabel = "Copy",
  copyAnalytics,
  className,
}: {
  /** The exact text copied. */
  code: string;
  /** What it is, for the header and the Copy button's name: "Hello world". */
  label: string;
  /** Replaces the visible label, for example a SegmentedControl of languages. */
  header?: ReactNode;
  /** Break long lines: anywhere (shell commands), or between words (a prompt). */
  wrap?: boolean | "words";
  onCopied?: () => void;
  copyLabel?: string;
  /** Spread onto the Copy button (`analyticsAction(...)`). */
  copyAnalytics?: Record<string, string>;
  className?: string;
}) {
  const { state, copy } = useCopyToClipboard();
  const codeRef = useRef<HTMLElement>(null);
  const statusId = useId();
  return (
    <div data-slot="code-block" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          {header ?? <p className="truncate text-xs font-medium text-fg-muted">{label}</p>}
        </div>
        <RowButton
          aria-label={
            state === "copied" ? `${label} copied` : `${copyLabel} ${label.toLowerCase()}`
          }
          aria-describedby={state === "failed" ? statusId : undefined}
          onClick={async () => {
            const ok = await copy(code);
            if (ok) onCopied?.();
            else if (codeRef.current) {
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(codeRef.current);
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
          }}
          {...copyAnalytics}
        >
          {state === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {state === "copied" ? "Copied" : copyLabel}
        </RowButton>
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className={cn(
          "m-0 max-w-full overflow-auto overscroll-contain rounded-[14px] border border-border bg-surface-2/60 p-4 text-xs leading-[18px] text-fg focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
          wrap === "words"
            ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
            : wrap && "break-all whitespace-pre-wrap",
        )}
      >
        <code ref={codeRef} translate="no" className="font-mono">
          {code}
        </code>
      </pre>
      {state === "failed" ? (
        <p id={statusId} role="status" className="text-xs text-fg-muted">
          Couldn't copy automatically. The code is selected: press Ctrl+C or ⌘C.
        </p>
      ) : (
        <span id={statusId} role="status" className="sr-only">
          {state === "copied" ? "Copied" : ""}
        </span>
      )}
    </div>
  );
}
