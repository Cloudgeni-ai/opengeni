import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchIcon } from "lucide-react";
import {
  SearchPreviewView,
  SearchResultsView,
} from "../src/components/session/search-results-view";
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
const params = new URLSearchParams(location.search);
const previewMessage = `${params.has("repeat") ? "An earlier mention of 09:00.\n\n" : ""}${message}${params.has("image") ? "\n\n![tracking](https://example.invalid/pixel.png)" : ""}`;

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

function SearchPreview() {
  const [selectedId, setSelectedId] = useState("selected");
  const [mobilePreview, setMobilePreview] = useState(false);

  return (
    <main className="min-h-dvh bg-bg text-fg">
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
              <SearchPreviewView
                title={results.find((result) => result.sessionId === selectedId)?.title ?? title}
                query={query}
                messages={[
                  {
                    key: selectedId,
                    role: "assistant",
                    text:
                      selectedId === "selected"
                        ? previewMessage
                        : "A note about the **09:00 standup** and yesterday’s queue.",
                    selected: true,
                    formatted: true,
                    snippet: selectedId === "selected" ? results[0]!.snippet : results[1]!.snippet,
                    offset:
                      selectedId === "selected" ? previewMessage.lastIndexOf(query) : undefined,
                  },
                ]}
                loading={false}
                error={null}
                onRetry={() => {}}
                onOpen={() => {}}
                onBack={() => setMobilePreview(false)}
                onPrevious={() => {}}
                onNext={() => {}}
                previousDisabled
                nextDisabled
                counter="Match 1 of 1"
                titleOnly={false}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SearchPreview />);
