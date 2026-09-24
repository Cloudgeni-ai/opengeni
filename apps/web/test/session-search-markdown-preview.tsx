import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
} from "lucide-react";
import { MarkdownText } from "../src/components/markdown";
import { SearchResultsView } from "../src/components/session/search-results-view";
import { Button } from "../src/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../src/components/ui/dialog";
import { Input } from "../src/components/ui/input";
import "../src/styles.css";

// This fixture is sample data and preview-only wiring, not a change to production search.
const query = "09:00";
const title = "Production activity review";
const message = `I called it a **multi-day activity ranking** because I was checking how many separate days each person submitted a request—not hours spent online.

In the same 14-day window ending **September 23, 2026**, three accounts submitted turns on more than one day:

| Account | Days | Direct turns | Example time |
|:--|--:|--:|:--|
| alpha@example.test | 2 | 44 | Sep 17, **09:00 UTC** |
| beta@example.test | 2 | 17 | Sep 16, 10:00 UTC |
| gamma@example.test | 2 | 12 | Sep 23, 11:00 UTC |

The remaining accounts submitted turns on a single day.

**This is not a measure of time spent in the product.** It records submissions, not active reading or work between them.`;

const results = [
  {
    sessionId: "selected",
    title,
    subtitle: "Sep 23, 2026",
    snippet: "…Sep 17, **09:00 UTC** | beta@example.test…",
    matchingMessages: 1,
    titleMatch: false,
  },
  {
    sessionId: "another",
    title: "Daily activity notes",
    subtitle: "Sep 21, 2026",
    snippet: "A note about the 09:00 standup and yesterday’s queue.",
    matchingMessages: 1,
    titleMatch: false,
  },
];

function FormattedMessage() {
  const messageRef = useRef<HTMLDivElement>(null);

  // Preview-only non-destructive text highlight over the real Markdown renderer.
  // The production implementation still needs its own search-highlight handling.
  useLayoutEffect(() => {
    const host = messageRef.current;
    if (!host || !CSS.highlights || typeof Highlight === "undefined") return;
    let frame = 0;
    const update = () => {
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        let from = 0;
        while (true) {
          const offset = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), from);
          if (offset < 0) break;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + query.length);
          ranges.push(range);
          from = offset + query.length;
        }
      }
      if (ranges.length) CSS.highlights.set("session-search-preview-hit", new Highlight(...ranges));
    };
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(host, { subtree: true, childList: true, characterData: true });
    frame = requestAnimationFrame(update);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete("session-search-preview-hit");
    };
  }, []);

  return (
    <div ref={messageRef} className="text-sm leading-6 text-fg">
      <MarkdownText text={message} compact />
    </div>
  );
}

function SearchPreview() {
  const [selectedId, setSelectedId] = useState("selected");
  const [mobilePreview, setMobilePreview] = useState(false);

  return (
    <main className="min-h-dvh bg-bg text-fg">
      <style>{`::highlight(session-search-preview-hit) { background-color: #236faf; color: white; text-decoration: underline; }`}</style>
      <div className="fixed top-2 left-2 z-[60] rounded-md bg-surface-3 px-3 py-1 text-xs text-fg-muted">
        PREVIEW · Sample data
      </div>
      <Dialog open>
        <DialogContent
          className="flex h-[min(760px,85dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl sm:p-0"
          aria-describedby="session-search-description"
        >
          <div className="shrink-0 border-b border-border px-4 pb-3 pt-4 pr-12">
            <DialogTitle className="mb-3 text-base">Search sessions</DialogTitle>
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute left-3 top-2.5 size-4 text-fg-subtle"
                aria-hidden="true"
              />
              <Input
                readOnly
                value={query}
                aria-label="Search session titles and messages"
                className="pl-9"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <DialogDescription id="session-search-description" className="flex-1 text-xs">
                Literal text in user and completed assistant messages.
              </DialogDescription>
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                Sessions
                <select
                  defaultValue="all"
                  aria-label="Search session status"
                  className="rounded-md border border-border bg-bg px-2 py-1 text-fg"
                >
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            </div>
          </div>
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.2fr)]">
            <div
              className={`min-h-0 flex-col md:flex md:border-r md:border-border ${mobilePreview ? "hidden" : "flex"}`}
            >
              <SearchResultsView
                query={query}
                results={results}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setMobilePreview(true);
                }}
                loading={false}
                error={null}
                onRetry={() => {}}
                hasMore={false}
                onMore={() => {}}
              />
            </div>
            <div
              className={`min-h-0 min-w-0 flex-col md:flex ${mobilePreview ? "flex" : "hidden"}`}
            >
              <section
                aria-label="Conversation preview"
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="md:hidden"
                    onClick={() => setMobilePreview(false)}
                    aria-label="Back to search results"
                  >
                    <ArrowLeftIcon className="size-4" />
                  </Button>
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h3>
                  <Button size="sm" onClick={() => {}}>
                    Open here <ArrowRightIcon className="size-3.5" />
                  </Button>
                </header>
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
                  <article className="mb-5 min-w-0 border-l-2 border-brand pl-3">
                    <p className="mb-1 text-xs font-medium text-fg-subtle">
                      Assistant · Matching passage
                    </p>
                    <FormattedMessage />
                  </article>
                </div>
                <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
                  <span className="flex-1 text-xs text-fg-muted" role="status">
                    Match 1 of 1
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled
                    aria-label="Previous match in preview"
                  >
                    <ChevronUpIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled
                    aria-label="Next match in preview"
                  >
                    <ChevronDownIcon className="size-4" />
                  </Button>
                </footer>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SearchPreview />);
