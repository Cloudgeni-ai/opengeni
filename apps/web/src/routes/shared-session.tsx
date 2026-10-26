// A shared chat: what anyone holding a share link reads. PUBLIC like
// `/reset-password`: the recipient is usually not signed in (often has no
// account), so `RootRouteComponent` renders this route ahead of the auth gate
// and WITHOUT the app context. Nothing here may call `useAppContext`.
//
// The page shows the snapshot the server stored when the link was shared: the
// person's messages and the replies, as text. It never loads images or files.
import type { SharedSession } from "@opengeni/sdk";
import { Markdown } from "@opengeni/react";
import { BrandMark, Wordmark } from "@opengeni/react/app/components/brand-mark";
import { Button } from "@opengeni/react/ui/button";
import { formatDate } from "@opengeni/react/ui/relative-time";
import { Skeleton } from "@opengeni/react/ui/skeleton";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { apiBaseUrl } from "@/api";

type Load =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "busy" }
  | { kind: "failed" }
  | { kind: "ready"; shared: SharedSession };

export async function fetchSharedSession(
  shareId: string,
  signal?: AbortSignal,
): Promise<Exclude<Load, { kind: "loading" }>> {
  try {
    const response = await fetch(
      `${apiBaseUrl}/v1/shared-sessions/${encodeURIComponent(shareId)}`,
      { credentials: "omit", ...(signal ? { signal } : {}) },
    );
    if (response.status === 404) return { kind: "gone" };
    if (response.status === 429) return { kind: "busy" };
    if (!response.ok) return { kind: "failed" };
    return { kind: "ready", shared: (await response.json()) as SharedSession };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "failed" };
  }
}

/** Keep the page out of search engines while it is open, and title the tab. */
function useSharedPageHead(title: string | null) {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.append(meta);
    return () => meta.remove();
  }, []);
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

function Shell(props: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-canvas text-fg">
      <div className="flex min-h-full flex-col">
        <header className="border-b border-border">
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-2 px-4 py-3 sm:px-6">
            <a href="/" className="flex items-center gap-2 text-fg" aria-label="Opengeni home">
              <BrandMark className="w-[22px]" />
              <Wordmark className="text-[17px]" />
            </a>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-4 pt-6 pb-16 sm:px-6 sm:pt-10">
          {props.children}
        </main>
      </div>
    </div>
  );
}

function Unavailable(props: { title: string; body: string; action?: ReactNode }) {
  return (
    <section className="flex flex-1 flex-col items-start justify-center gap-3 py-16">
      <h1 className="text-xl font-semibold text-fg">{props.title}</h1>
      <p className="max-w-prose text-sm text-fg-muted">{props.body}</p>
      {props.action}
    </section>
  );
}

export function SharedSessionView(props: { load: Load; onRetry?: (() => void) | undefined }) {
  const { load } = props;
  if (load.kind === "loading") {
    return (
      <div className="grid gap-4" aria-busy="true" aria-label="Opening the conversation">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-6 ml-auto h-12 w-1/2 rounded-xl" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (load.kind === "gone") {
    return (
      <Unavailable
        title="This link doesn't open anymore"
        body="The person who shared this conversation may have stopped sharing it, or the link may be mistyped. Ask them for a new link."
      />
    );
  }
  if (load.kind === "busy" || load.kind === "failed") {
    return (
      <Unavailable
        title="Couldn't open this conversation"
        body={
          load.kind === "busy"
            ? "Too many requests just now. Wait a minute and try again."
            : "Check your connection and try again."
        }
        action={
          props.onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }
  const { shared } = load;
  return (
    <article aria-labelledby="shared-session-title" className="min-w-0">
      <header className="mb-8 border-b border-border pb-5">
        <h1
          id="shared-session-title"
          className="text-2xl leading-tight font-semibold text-balance [overflow-wrap:anywhere] text-fg"
        >
          {shared.title}
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          Shared conversation ·{" "}
          <time dateTime={shared.sharedAt}>{formatDate(shared.sharedAt)}</time>
        </p>
      </header>
      {shared.omittedMessageCount > 0 ? (
        <p className="mb-6 text-sm text-fg-muted">
          Earlier messages aren't included. This shows the latest part of the conversation.
        </p>
      ) : null}
      {shared.messages.length === 0 ? (
        <p className="text-sm text-fg-muted">There were no messages yet when this was shared.</p>
      ) : (
        <ol className="flex flex-col gap-6">
          {shared.messages.map((message, index) =>
            message.role === "user" ? (
              // oxlint-disable-next-line react/no-array-index-key -- a fixed snapshot; messages have no ids and never reorder
              <li key={index} className="flex justify-end" data-shared-message="user">
                <div className="w-fit max-w-[85%] min-w-0 rounded-lg rounded-br-sm border border-border bg-surface-2 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <span className="sr-only">They wrote: </span>
                  {message.text}
                </div>
              </li>
            ) : (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- a fixed snapshot; messages have no ids and never reorder
                key={index}
                className="min-w-0 text-[15px] leading-7 [overflow-wrap:anywhere]"
                data-shared-message="assistant"
              >
                <span className="sr-only">Reply: </span>
                <Markdown softLineBreaks suppressImages>
                  {message.text}
                </Markdown>
              </li>
            ),
          )}
        </ol>
      )}
      <p className="mt-12 border-t border-border pt-4 text-xs text-fg-subtle">
        A copy of a conversation someone shared. It doesn't change when they keep chatting.
      </p>
    </article>
  );
}

export function SharedSessionRoute(props: { shareId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const open = useCallback(
    (signal?: AbortSignal) => {
      setLoad({ kind: "loading" });
      void fetchSharedSession(props.shareId, signal).then(
        (next) => {
          if (!signal?.aborted) setLoad(next);
        },
        () => undefined,
      );
    },
    [props.shareId],
  );
  useEffect(() => {
    const controller = new AbortController();
    open(controller.signal);
    return () => controller.abort();
  }, [open]);
  useSharedPageHead(load.kind === "ready" ? load.shared.title : null);
  return (
    <Shell>
      <SharedSessionView load={load} onRetry={() => open()} />
    </Shell>
  );
}
