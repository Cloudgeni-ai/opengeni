import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { SearchText } from "./search-text";
import { cn } from "@/lib/utils";

export type SearchResultSummary = {
  sessionId: string;
  title: string;
  subtitle: string;
  snippet: string;
  matchingMessages: number;
  titleMatch: boolean;
};

export function SearchResultsView(props: {
  query: string;
  results: SearchResultSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hasMore: boolean;
  onMore: () => void;
  scrollPosition?: RefObject<number>;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!props.loading && list.current && props.scrollPosition)
      list.current.scrollTop = props.scrollPosition.current;
  }, [props.results, props.loading, props.scrollPosition]);
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!props.results.length) return;
    event.preventDefault();
    const current = props.results.findIndex((result) => result.sessionId === props.selectedId);
    const next = Math.max(
      0,
      Math.min(props.results.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
    );
    props.onSelect(props.results[next]!.sessionId);
    list.current?.querySelectorAll<HTMLButtonElement>("[data-search-result]")[next]?.focus();
  }
  return (
    <div
      ref={list}
      className="min-h-0 overflow-y-auto overscroll-contain"
      aria-label="Matching sessions"
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        if (!props.loading && props.scrollPosition)
          props.scrollPosition.current = event.currentTarget.scrollTop;
      }}
    >
      {!props.query.trim() ? (
        <SearchMessage>Search session titles and messages across this workspace.</SearchMessage>
      ) : props.error ? (
        <SearchMessage>
          <span role="alert">{props.error}</span>
          <Button variant="outline" size="sm" onClick={props.onRetry}>
            Retry search
          </Button>
        </SearchMessage>
      ) : props.loading && props.results.length === 0 ? (
        <SearchMessage>
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          <span role="status">Searching conversations…</span>
        </SearchMessage>
      ) : props.results.length === 0 ? (
        <SearchMessage>
          <SearchIcon className="size-5" aria-hidden="true" />
          <span role="status">No matching sessions. Try a shorter phrase or different words.</span>
        </SearchMessage>
      ) : (
        <>
          <div className="sr-only" role="status">
            {props.results.length} matching sessions{props.hasMore ? ", more available" : ""}
          </div>
          {props.results.map((result) => (
            <button
              key={result.sessionId}
              type="button"
              data-search-result=""
              aria-pressed={props.selectedId === result.sessionId}
              onClick={() => props.onSelect(result.sessionId)}
              className={cn(
                "block w-full border-b border-border/60 px-4 py-4 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                props.selectedId === result.sessionId && "bg-surface-2",
              )}
            >
              <div className="truncate text-sm font-medium text-fg">
                <SearchText text={result.title} query={props.query} />
              </div>
              <div className="mt-1 truncate text-xs text-fg-subtle">{result.subtitle}</div>
              {result.snippet ? (
                <p className="mt-2 line-clamp-3 break-words text-sm leading-relaxed text-fg-muted">
                  <SearchText text={result.snippet} query={props.query} />
                </p>
              ) : null}
              <div className="mt-2 text-xs text-fg-subtle">
                {result.matchingMessages > 0 ? "Message match" : "Title or opening message match"}
              </div>
            </button>
          ))}
          {props.hasMore ? (
            <div className="p-3">
              <Button
                variant="ghost"
                className="w-full"
                disabled={props.loading}
                onClick={props.onMore}
              >
                {props.loading ? "Loading…" : "More results"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export type SearchPreviewMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
  selected: boolean;
};

export function SearchPreviewView(props: {
  title: string;
  query: string;
  messages: SearchPreviewMessage[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: () => void;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  previousDisabled: boolean;
  nextDisabled: boolean;
  counter: string;
  titleOnly: boolean;
  scrollPosition?: RefObject<number>;
}) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!props.loading && body.current && props.scrollPosition)
      body.current.scrollTop = props.scrollPosition.current;
  }, [props.messages, props.loading, props.scrollPosition]);
  return (
    <section aria-label="Conversation preview" className="flex min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          onClick={props.onBack}
          aria-label="Back to search results"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</h3>
        <Button size="sm" onClick={props.onOpen} disabled={props.loading || !!props.error}>
          {props.titleOnly ? "Open session" : "Open here"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </header>
      <div
        ref={body}
        onScroll={(event) => {
          if (!props.loading && props.scrollPosition)
            props.scrollPosition.current = event.currentTarget.scrollTop;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
      >
        {props.loading ? (
          <SearchMessage>
            <span role="status">Loading context…</span>
          </SearchMessage>
        ) : props.error ? (
          <SearchMessage>
            <span role="alert">{props.error}</span>
            <Button variant="outline" size="sm" onClick={props.onRetry}>
              Retry preview
            </Button>
          </SearchMessage>
        ) : props.titleOnly ? (
          <SearchMessage>This session title matches. No matching message was found.</SearchMessage>
        ) : (
          props.messages.map((message) => (
            <article
              key={message.key}
              className={cn(
                "mb-5 border-l-2 pl-3",
                message.selected ? "border-brand" : "border-transparent",
              )}
            >
              <p className="mb-1 text-xs font-medium text-fg-subtle">
                {message.role === "user" ? "User" : "Assistant"}
                {message.selected ? " · Matching passage" : ""}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6 text-fg">
                <SearchText text={message.text} query={props.query} />
              </p>
            </article>
          ))
        )}
      </div>
      {!props.titleOnly ? (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
          <span className="flex-1 text-xs text-fg-muted" role="status">
            {props.counter}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onPrevious}
            disabled={props.previousDisabled || props.loading}
            aria-label="Previous match in preview"
          >
            <ChevronUpIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onNext}
            disabled={props.nextDisabled || props.loading}
            aria-label="Next match in preview"
          >
            <ChevronDownIcon className="size-4" />
          </Button>
        </footer>
      ) : null}
    </section>
  );
}

function SearchMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 px-6 py-8 text-center text-sm leading-6 text-fg-muted">
      {children}
    </div>
  );
}
