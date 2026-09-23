import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Internal layout blocks only. Readers see a single continuous document.
export function textBlocks(text: string) {
  const blocks: { start: number; text: string }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 2000, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + 1000) end = newline + 1;
      else {
        const space = text.lastIndexOf(" ", end);
        if (space > start + 1000) end = space + 1;
        else if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      }
    }
    blocks.push({ start, text: text.slice(start, end) });
    start = end;
  }
  return blocks;
}
export function ContextTextReader({
  text,
  initialQuery = "",
  code = false,
}: {
  text: string;
  initialQuery?: string;
  code?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [finding, setFinding] = useState(Boolean(initialQuery));
  const [query, setQuery] = useState(initialQuery);
  const [occurrence, setOccurrence] = useState(0);
  const [jumpRevision, setJumpRevision] = useState(0);
  const pendingJump = useRef(true);
  const blocks = useMemo(() => textBlocks(text), [text]);
  const matches = useMemo(() => {
    if (!query) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(escaped, "gi");
    const result: number[] = [];
    for (const match of text.matchAll(expression)) result.push(match.index);
    return result;
  }, [text, query]);
  const active = matches[Math.min(occurrence, matches.length - 1)] ?? -1;
  const large = text.length > 50000;
  useLayoutEffect(() => {
    const viewport =
      root.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
    setScrollElement(viewport);
    const update = () => {
      if (viewport && body.current)
        setMargin(
          body.current.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop,
        );
    };
    update();
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  }, [finding]);
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => Math.max(24, Math.ceil((blocks[index]?.text.length ?? 0) / 65) * 24),
    scrollMargin: margin,
    overscan: 3,
    enabled: large,
    initialRect: { width: 500, height: 600 },
  });
  useEffect(() => {
    if (!pendingJump.current || active < 0 || !large || !scrollElement) return;
    const index = blocks.findIndex(
      (block) => active >= block.start && active < block.start + block.text.length,
    );
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [active, blocks, large, scrollElement, virtualizer, jumpRevision]);
  const virtualItems = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    if (!pendingJump.current || active < 0) return;
    const mark = body.current?.querySelector("mark");
    if (mark) {
      mark.scrollIntoView?.({ block: "center" });
      pendingJump.current = false;
    }
  });
  const move = (delta: number) => {
    pendingJump.current = true;
    setJumpRevision((n) => n + 1);
    setOccurrence((n) => (n + delta + matches.length) % Math.max(1, matches.length));
  };
  const renderText = (value: string, start: number) => {
    const offset = Math.max(0, active - start);
    const matchEnd = Math.min(value.length, active + query.length - start);
    return finding && active >= 0 && matchEnd > 0 && active < start + value.length ? (
      <>
        {value.slice(0, offset)}
        <mark className="rounded-sm bg-amber-300/25 text-inherit">
          {value.slice(offset, matchEnd)}
        </mark>
        {value.slice(matchEnd)}
      </>
    ) : (
      value
    );
  };
  return (
    <div
      ref={root}
      tabIndex={0}
      aria-label="Context text"
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("button,input,a"))
          root.current?.focus({ preventScroll: true });
      }}
      className="min-w-0"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "f") {
          event.preventDefault();
          setFinding(true);
          requestAnimationFrame(() => search.current?.focus());
        }
        if (event.key === "Escape") {
          setFinding(false);
          setQuery("");
        }
      }}
    >
      <div className="sticky top-0 z-10 mb-3 flex min-w-0 items-center justify-between gap-2 border-b border-border bg-bg py-2">
        {finding ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              ref={search}
              autoFocus
              aria-label="Find in content"
              placeholder="Find in text…"
              className="h-7 min-w-0 flex-1"
              value={query}
              onChange={(event) => {
                pendingJump.current = true;
                setQuery(event.target.value);
                setOccurrence(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  move(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <span className="shrink-0 text-2xs text-fg-subtle" aria-live="polite">
              {query ? (matches.length ? `${occurrence + 1}/${matches.length}` : "No results") : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous match"
              disabled={!matches.length}
              onClick={() => move(-1)}
            >
              <ArrowUpIcon className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next match"
              disabled={!matches.length}
              onClick={() => move(1)}
            >
              <ArrowDownIcon className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close find"
              onClick={() => {
                setFinding(false);
                setQuery("");
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => setFinding(true)}>
            <SearchIcon className="size-3" />
            Find
          </Button>
        )}
        {!finding ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast.success("Copied");
              } catch {
                toast.error("Could not copy");
              }
            }}
          >
            <CopyIcon className="size-3" />
            Copy
          </Button>
        ) : null}
      </div>
      <div
        ref={body}
        className={
          code
            ? "font-mono text-xs leading-6 text-fg-muted"
            : "mx-auto max-w-[72ch] font-sans text-[13px] leading-[21px] text-fg"
        }
        style={large ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined}
      >
        {large ? (
          virtualItems.map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full whitespace-pre-wrap [overflow-wrap:anywhere]"
              style={{ transform: `translateY(${item.start - margin}px)` }}
            >
              {renderText(blocks[item.index]!.text, blocks[item.index]!.start)}
            </div>
          ))
        ) : (
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderText(text, 0)}</div>
        )}
      </div>
    </div>
  );
}
