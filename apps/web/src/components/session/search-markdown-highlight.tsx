import { useLayoutEffect, useRef, useState } from "react";
import { MarkdownText } from "@/components/markdown";
import { SearchText } from "./search-text";

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Validate a hit against its exact source offset; never format a stale event as the match. */
export function matchAtOffset(text: string, query: string, offset: number): number {
  if (!query || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return -1;
  const expression = new RegExp(escapeRegex(query), "iyu");
  expression.lastIndex = offset;
  return expression.exec(text)?.index === offset ? offset : -1;
}

/** Search hit excerpts are authoritative until the exact retained event has been revalidated. */
export function selectedFormattedMessage(
  preview: { status: "available"; text: string } | { status: "unavailable" },
  match: { messageMatchOffset: number },
  query: string,
): string | null {
  if (preview.status !== "available" || typeof preview.text !== "string") return null;
  if (preview.text.length > 12_000) return null;
  return matchAtOffset(preview.text, query, match.messageMatchOffset) >= 0 ? preview.text : null;
}

let nextHighlight = 0;

/** Non-mutating browser highlight so ReactMarkdown keeps its own text and table DOM. */
export function SearchMarkdown({
  text,
  query,
  snippet,
  offset,
}: {
  text: string;
  query: string;
  snippet: string;
  offset?: number;
}) {
  const body = useRef<HTMLDivElement>(null);
  const name = useRef("");
  const navigated = useRef(false);
  if (!name.current) name.current = `og-session-search-${++nextHighlight}`;
  const [sourceOnly, setSourceOnly] = useState(false);
  const supported =
    typeof CSS !== "undefined" && Boolean(CSS.highlights) && typeof Highlight !== "undefined";

  useLayoutEffect(() => {
    const root = body.current;
    if (!root || !supported || !query) return;
    const highlightName = name.current;
    const expression = new RegExp(escapeRegex(query), "giu");
    const sourceHits = [...text.matchAll(expression)];
    const ordinal = sourceHits.findIndex((hit) => hit.index === (offset ?? sourceHits[0]?.index));
    navigated.current = false;
    let frame = 0;
    const update = () => {
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement?.closest("[data-og-image-placeholder]")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      let tooMany = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const content = node.textContent ?? "";
        for (const match of content.matchAll(expression)) {
          // A one-character query can occur thousands of times in 12K of text.
          // Keep the source excerpt visible instead of constructing unbounded DOM ranges.
          if (ranges.length === 128) {
            tooMany = true;
            break;
          }
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          ranges.push(range);
        }
        if (tooMany) break;
      }
      // Markdown can hide literal source matches in link destinations or syntax.
      // Never point at a different occurrence when source/visible ordinals diverge.
      const selected =
        !tooMany && sourceHits.length === ranges.length && ordinal >= 0 ? ranges[ordinal] : null;
      if (selected) CSS.highlights.set(highlightName, new Highlight(selected));
      else CSS.highlights.delete(highlightName);
      setSourceOnly(!selected);
      if (!selected || navigated.current) return;
      const rect = selected.getBoundingClientRect();
      const pane = root.closest<HTMLElement>("[data-search-preview-scroll]");
      if (!pane || (!rect.width && !rect.height)) return;
      const paneRect = pane.getBoundingClientRect();
      if (rect.top < paneRect.top + 24 || rect.bottom > paneRect.bottom - 24)
        pane.scrollTop += rect.top - paneRect.top - 80;
      const cell = selected.startContainer.parentElement;
      const horizontalScroller = cell?.closest<HTMLElement>('[tabindex="0"]');
      if (horizontalScroller) {
        const scrollerRect = horizontalScroller.getBoundingClientRect();
        if (rect.left < scrollerRect.left + 8 || rect.right > scrollerRect.right - 8)
          horizontalScroller.scrollLeft += rect.left - scrollerRect.left - 24;
      }
      navigated.current = true;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            navigated.current = false;
            schedule();
          });
    resize?.observe(root.closest<HTMLElement>("[data-search-preview-scroll]") ?? root);
    schedule();
    return () => {
      observer.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete(highlightName);
    };
  }, [text, query, offset, supported]);

  if (!supported)
    return (
      <>
        <p className="mb-3 text-xs text-fg-muted">
          Match in message source: <SearchText text={snippet} query={query} />
        </p>
        <MarkdownText text={text} compact suppressImages />
      </>
    );
  return (
    <>
      <style>{`::highlight(${name.current}) { background: var(--og-accent, #236faf); color: var(--og-accent-fg, white); text-decoration: underline; }`}</style>
      {sourceOnly ? (
        <p className="mb-3 text-xs text-fg-muted">
          Match in message source: <SearchText text={snippet} query={query} />
        </p>
      ) : null}
      <div ref={body} className="min-w-0">
        <MarkdownText text={text} compact suppressImages />
      </div>
    </>
  );
}
