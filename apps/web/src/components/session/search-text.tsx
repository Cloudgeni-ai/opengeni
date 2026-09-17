import { Fragment } from "react";

/** Plain text, never HTML: snippets are untrusted conversation content. */
export function SearchText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    const start = match.index;
    parts.push(
      <Fragment key={start}>
        {text.slice(offset, start)}
        <mark className="rounded-sm bg-brand/20 px-0 text-fg underline decoration-brand/60 underline-offset-2">
          {match[0]}
        </mark>
      </Fragment>,
    );
    offset = start + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}
