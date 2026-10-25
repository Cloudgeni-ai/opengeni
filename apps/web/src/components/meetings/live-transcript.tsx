/**
 * The live transcript preview: what is being said while a meeting is
 * recorded, one turn per stretch of speech on a track. It is a preview; the
 * meeting's real transcript (with speakers told apart) replaces it once the
 * recording is done.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon } from "lucide-react";

import { Button } from "@opengeni/react/ui/button";
import { cn } from "@opengeni/react/app/lib/utils";
import { formatClock } from "@opengeni/react/recordings";

import { SpeakerDot } from "./meeting-transcript";

export type LiveTranscriptLine = {
  trackNumber: number;
  startMilliseconds: number;
  text: string;
};

type LiveTurn = {
  key: string;
  trackNumber: number;
  startMilliseconds: number;
  texts: string[];
};

/** Consecutive lines from one track read as one turn. */
export function groupLiveTurns(lines: readonly LiveTranscriptLine[]): LiveTurn[] {
  const sorted = [...lines].sort(
    (a, b) => a.startMilliseconds - b.startMilliseconds || a.trackNumber - b.trackNumber,
  );
  const turns: LiveTurn[] = [];
  for (const line of sorted) {
    const text = line.text.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.trackNumber === line.trackNumber) {
      last.texts.push(text);
      continue;
    }
    turns.push({
      key: `${line.trackNumber}:${line.startMilliseconds}`,
      trackNumber: line.trackNumber,
      startMilliseconds: line.startMilliseconds,
      texts: [text],
    });
  }
  return turns;
}

const NO_PARTIALS: readonly { trackNumber: number; text: string }[] = [];

/**
 * Joins a turn's pieces into readable text. Streaming providers send pieces
 * that end in a trailing ellipsis while they wait, or a space before a full
 * stop; joined naively those read as "between you…." or "dog .".
 */
export function tidyLiveText(pieces: readonly string[]): string {
  return pieces
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/(?:…|\.{3})(?=[.,!?;:…])/g, "")
    .replace(/([,!?;:])\1+/g, "$1")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .replace(/\s{2,}/g, " ");
}

/** Words still being heard, without the provider's "still listening" ellipsis. */
export function tidyPartialText(text: string): string {
  return tidyLiveText([text]).replace(/\s*(?:…|\.{3})$/, "");
}

export function LiveTranscript({
  lines,
  partials = NO_PARTIALS,
  speakerName,
  status,
  empty,
  heading = true,
  className,
}: {
  lines: readonly LiveTranscriptLine[];
  /** Words still being heard per track, which may change. */
  partials?: readonly { trackNumber: number; text: string }[];
  speakerName: (trackNumber: number) => string;
  /** A short line about the connection, such as reconnecting. */
  status?: { text: string; tone: "muted" | "waiting" } | null;
  /** Shown before anything has been said. */
  empty: string;
  /** Show the "Live transcript · preview" heading; off where the page already has one. */
  heading?: boolean;
  className?: string;
}) {
  const turns = useMemo(() => groupLiveTurns(lines), [lines]);
  const heard = partials
    .map((partial) => ({ ...partial, text: tidyPartialText(partial.text) }))
    .filter((partial) => partial.text);
  // Words still being heard from whoever spoke last continue their turn.
  const lastTrack = turns.at(-1)?.trackNumber;
  const continuing = heard.find((partial) => partial.trackNumber === lastTrack) ?? null;
  const newTurns = heard.filter((partial) => partial !== continuing);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the newest words unless the reader scrolled up to reread.
  const following = useRef(true);
  const [scroll, setScroll] = useState({ above: false, behind: false });
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      following.current = atEnd;
      const above = element.scrollTop > 4;
      setScroll((previous) =>
        previous.above === above && previous.behind === !atEnd
          ? previous
          : { above, behind: !atEnd },
      );
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);
  const content = `${turns.length}:${turns.at(-1)?.texts.length ?? 0}:${heard
    .map((partial) => partial.text.length)
    .join(",")}`;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    const above = element.scrollTop > 4;
    setScroll((previous) => (previous.above === above ? previous : { ...previous, above }));
  }, [content]);
  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    element.scrollTop = element.scrollHeight;
  };

  const statusLine = status ? (
    status.tone === "waiting" ? (
      // A dropped connection is a state of the whole box, so it reads as a banner over it.
      <p
        className="flex items-start gap-2 rounded-[10px] border border-status-waiting/40 bg-status-waiting/10 px-3 py-2 text-xs leading-4.5 font-medium text-fg-label"
        aria-live="polite"
      >
        <span
          aria-hidden="true"
          className="mt-1.5 inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-status-waiting motion-reduce:animate-none"
        />
        {status.text}
      </p>
    ) : (
      <p className="text-xs leading-4 text-fg-muted" aria-live="polite">
        {status.text}
      </p>
    )
  ) : null;

  return (
    <section aria-label="Live transcript" className={cn("grid min-w-0 gap-2", className)}>
      {heading ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-xs leading-4 font-medium text-fg-label">
              Live transcript <span className="font-normal text-fg-muted">· preview</span>
            </h3>
            {status?.tone === "muted" ? statusLine : null}
          </div>
          {status?.tone === "waiting" ? statusLine : null}
        </>
      ) : (
        statusLine
      )}
      <div className="relative min-w-0 rounded-[10px] border border-border bg-surface-2/60">
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label="Live transcript text"
          tabIndex={0}
          className={cn(
            "max-h-64 min-h-16 overflow-y-auto rounded-[10px] px-3 py-2.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            // Older text above fades out, so a clipped first line reads as "scroll up".
            scroll.above && "[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]",
          )}
        >
          {turns.length === 0 && heard.length === 0 ? (
            <p className="text-sm leading-5 text-fg-muted">{empty}</p>
          ) : (
            <ol className="grid gap-3">
              {turns.map((turn, index) => (
                <li key={turn.key} className="grid min-w-0 gap-0.5">
                  <div className="flex items-center gap-2">
                    <SpeakerDot slot={turn.trackNumber + 1} />
                    <span className="text-xs leading-4 font-semibold text-fg">
                      {speakerName(turn.trackNumber)}
                    </span>
                    <span className="text-xs leading-4 text-fg-muted tabular-nums">
                      {formatClock(turn.startMilliseconds)}
                    </span>
                  </div>
                  <p className="text-sm leading-5 text-pretty text-fg">
                    {tidyLiveText(turn.texts)}
                    {continuing && index === turns.length - 1 ? (
                      <span className="text-fg-label"> {continuing.text}</span>
                    ) : null}
                  </p>
                </li>
              ))}
              {newTurns.map((partial) => (
                <li key={`partial:${partial.trackNumber}`} className="grid min-w-0 gap-0.5">
                  <div className="flex items-center gap-2">
                    <SpeakerDot slot={partial.trackNumber + 1} />
                    <span className="text-xs leading-4 font-semibold text-fg">
                      {speakerName(partial.trackNumber)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs leading-4 font-medium text-fg-label">
                      <span
                        aria-hidden="true"
                        className="inline-block size-1.5 animate-pulse rounded-full bg-status-waiting motion-reduce:animate-none"
                      />
                      now
                    </span>
                  </div>
                  <p className="text-sm leading-5 text-fg-label">{partial.text}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
        {scroll.behind ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={jumpToLatest}
            className="absolute right-3 bottom-2 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.08)] pointer-coarse:h-11"
          >
            <ArrowDownIcon aria-hidden="true" />
            Latest
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** The local recorder's live state as the panel's status line, or null when all is well. */
export function liveStatus(
  tracks: readonly { state: string; error: { message: string } | null }[],
): { text: string; tone: "muted" | "waiting" } | null {
  if (tracks.length === 0) return null;
  if (tracks.every((track) => track.state === "unavailable")) {
    return { text: "Live preview unavailable. The recording is unaffected.", tone: "muted" };
  }
  if (tracks.some((track) => track.state === "reconnecting")) {
    return {
      text: "Reconnecting the live text. The recording itself is unaffected, and its full transcript comes after you stop.",
      tone: "waiting",
    };
  }
  if (tracks.every((track) => track.state === "connecting")) {
    return { text: "Connecting", tone: "muted" };
  }
  return null;
}
