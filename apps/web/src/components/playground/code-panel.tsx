import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "@/components/ui/copy-field";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { RowButton } from "@/components/ui/page-actions";
import { cn } from "@/lib/utils";

import {
  INSTALL_COMMAND,
  changedLines,
  codeText,
  type CodeFile,
  type CodeFileId,
} from "./integration-code";

const MARK_MS = 2400;

/**
 * The few lines a product writes, live: every playground control rewrites
 * them, the panel opens the file it touched and marks the changed lines.
 */
export function CodePanel({
  files,
  className,
}: {
  files: readonly CodeFile[];
  className?: string;
}) {
  const [active, setActive] = useState<CodeFileId>("page");
  const [marked, setMarked] = useState<Partial<Record<CodeFileId, number[]>>>({});
  const previous = useRef(files);
  const preRefs = useRef<Partial<Record<CodeFileId, HTMLPreElement | null>>>({});

  useEffect(() => {
    if (previous.current === files) return;
    const changed = changedLines(previous.current, files);
    previous.current = files;
    const touched = (Object.keys(changed) as CodeFileId[])[0];
    if (!touched) return;
    setMarked(changed);
    setActive(touched);
    const timer = setTimeout(() => setMarked({}), MARK_MS);
    return () => clearTimeout(timer);
  }, [files]);

  // Bring the first changed line into view inside the code, never the page.
  useEffect(() => {
    const first = marked[active]?.[0];
    const pre = preRefs.current[active];
    if (first === undefined || !pre) return;
    const row = pre.querySelector<HTMLElement>(`[data-line="${first}"]`);
    if (!row) return;
    const offset = row.getBoundingClientRect().top - pre.getBoundingClientRect().top;
    const top = pre.scrollTop + offset - pre.clientHeight / 3;
    pre.scrollTo?.({ top: Math.max(0, top), behavior: "smooth" });
  }, [active, marked]);

  const current = files.find((file) => file.id === active) ?? files[0]!;
  return (
    <section aria-label="The code for this chat" className={cn("flex min-h-0 flex-col", className)}>
      <LineTabs
        value={active}
        onValueChange={(value) => setActive(value as CodeFileId)}
        className="min-h-0 flex-1"
      >
        <LineTabsList
          aria-label="Files"
          barClassName="px-1"
          trailing={<CopyButton text={codeText(current)} label={current.name} />}
        >
          {files.map((file) => (
            <LineTabsTrigger
              key={file.id}
              value={file.id}
              className="font-mono text-xs"
              data-changed={marked[file.id] ? "" : undefined}
            >
              {file.name}
            </LineTabsTrigger>
          ))}
        </LineTabsList>
        {files.map((file) => (
          <LineTabsContent
            key={file.id}
            value={file.id}
            // Kept mounted, so each file keeps its scroll and its marks.
            forceMount
            className="min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            <pre
              ref={(node) => {
                preRefs.current[file.id] = node;
              }}
              tabIndex={0}
              aria-label={file.name}
              className="m-0 h-full max-w-full overflow-auto overscroll-contain py-3 max-lg:max-h-[360px] font-mono text-xs leading-[18px] text-fg focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <code className="block min-w-max">
                {file.lines.map((entry, index) => (
                  <span
                    // Lines are positional: a change rewrites one in place.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={index}
                    data-line={index}
                    data-changed={marked[file.id]?.includes(index) ? "" : undefined}
                    className="og-code-line block px-4"
                  >
                    {entry.text || " "}
                  </span>
                ))}
              </code>
            </pre>
          </LineTabsContent>
        ))}
      </LineTabs>
      <p className="flex min-w-0 items-center gap-2 border-t border-border px-4 py-2 font-mono text-xs text-fg-muted">
        <span aria-hidden="true" className="text-fg-subtle">
          $
        </span>
        <span className="min-w-0 truncate">{INSTALL_COMMAND}</span>
      </p>
      <p className="sr-only" aria-live="polite">
        {Object.keys(marked).length > 0
          ? `${files.find((file) => file.id === active)?.name} updated`
          : ""}
      </p>
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopyToClipboard();
  return (
    <RowButton
      size="xs"
      variant="ghost"
      className="h-7 px-2"
      aria-label={state === "copied" ? `${label} copied` : `Copy ${label}`}
      onClick={() => void copy(text)}
    >
      {state === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {state === "copied" ? "Copied" : "Copy"}
    </RowButton>
  );
}
