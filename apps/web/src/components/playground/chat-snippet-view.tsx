import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/components/ui/copy-field";

import { changedLines } from "./chat-snippet";

/**
 * A short code block. With `marks`, the lines the last change wrote stay
 * marked until the next change, so there is time to read them.
 */
export function ChatSnippetView({
  lines,
  label,
  marks = false,
  quiet = false,
}: {
  lines: readonly string[];
  label: string;
  marks?: boolean;
  /** A secondary block: smaller presence. */
  quiet?: boolean;
}) {
  const previous = useRef(lines);
  const [marked, setMarked] = useState<number[]>([]);
  useEffect(() => {
    if (previous.current === lines) return;
    if (marks) setMarked(changedLines(previous.current, lines));
    previous.current = lines;
  }, [lines, marks]);
  const { state, copy } = useCopyToClipboard();
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-xs text-fg-muted">{label}</p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="pointer-coarse:h-11"
          aria-label={state === "copied" ? `${label} copied` : `Copy ${label}`}
          onClick={() => void copy(lines.join("\n"))}
        >
          {state === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        data-snippet={marks ? "page" : "server"}
        className={
          quiet
            ? "m-0 max-w-full overflow-x-auto rounded-[14px] border border-border bg-surface-2/60 py-3 font-mono text-xs leading-[18px] text-fg-muted focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none max-sm:whitespace-pre-wrap"
            : "m-0 max-w-full overflow-x-auto rounded-[14px] border border-border bg-surface py-3 font-mono text-xs leading-[20px] text-fg focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none max-sm:whitespace-pre-wrap"
        }
      >
        <code className="block sm:min-w-max">
          {lines.map((line, index) => (
            <span
              // Lines are positional: a change rewrites one in place.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              data-changed={marked.includes(index) ? "" : undefined}
              className="og-code-line block px-3 max-sm:pl-7 max-sm:-indent-4"
            >
              {line || " "}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
