import { useEffect, useRef, useState } from "react";

import { changedLines } from "./chat-snippet";

/**
 * The snippet, with the lines the last change wrote marked until the next
 * change, so there is time to read them.
 */
export function ChatSnippetView({ lines }: { lines: readonly string[] }) {
  const previous = useRef(lines);
  const [marked, setMarked] = useState<number[]>([]);
  useEffect(() => {
    if (previous.current === lines) return;
    setMarked(changedLines(previous.current, lines));
    previous.current = lines;
  }, [lines]);
  return (
    <pre
      tabIndex={0}
      aria-label="The code for this chat"
      className="m-0 max-w-full overflow-x-auto rounded-[14px] border border-border bg-surface py-3 font-mono text-xs leading-[20px] text-fg focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <code className="block min-w-max">
        {lines.map((line, index) => (
          <span
            // Lines are positional: a change rewrites one in place.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            data-changed={marked.includes(index) ? "" : undefined}
            className="og-code-line block px-3"
          >
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}
