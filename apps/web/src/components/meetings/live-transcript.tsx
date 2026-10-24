/**
 * The live transcript preview: what is being said while a meeting is
 * recorded, one turn per stretch of speech on a track. It is a preview; the
 * meeting's real transcript (with speakers told apart) replaces it once the
 * recording is done.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

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

export function LiveTranscript({
  lines,
  partials = NO_PARTIALS,
  speakerName,
  status,
  empty,
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
  className?: string;
}) {
  const turns = useMemo(() => groupLiveTurns(lines), [lines]);
  const heard = partials.filter((partial) => partial.text.trim());
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the newest words unless the reader scrolled up to reread.
  const following = useRef(true);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);
  const content = `${turns.length}:${turns.at(-1)?.texts.length ?? 0}:${heard
    .map((partial) => partial.text.length)
    .join(",")}`;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [content]);

  return (
    <section aria-label="Live transcript" className={cn("grid min-w-0 gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs leading-4 font-medium text-fg-label">
          Live transcript <span className="font-normal text-fg-muted">· preview</span>
        </h3>
        {status ? (
          <p
            className={cn(
              "text-xs leading-4",
              status.tone === "waiting" ? "font-medium text-fg-label" : "text-fg-muted",
            )}
            aria-live="polite"
          >
            {status.tone === "waiting" ? (
              <span
                aria-hidden="true"
                className="mr-1.5 inline-block size-1.5 rounded-full bg-status-waiting align-middle"
              />
            ) : null}
            {status.text}
          </p>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Live transcript text"
        tabIndex={0}
        className="max-h-64 min-h-16 overflow-y-auto rounded-[10px] bg-surface-2/60 px-3 py-2.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {turns.length === 0 && heard.length === 0 ? (
          <p className="text-sm leading-5 text-fg-muted">{empty}</p>
        ) : (
          <ol className="grid gap-3">
            {turns.map((turn) => (
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
                <p className="text-sm leading-5 text-pretty text-fg">{turn.texts.join(" ")}</p>
              </li>
            ))}
            {heard.map((partial) => (
              <li key={`partial:${partial.trackNumber}`} className="grid min-w-0 gap-0.5">
                <div className="flex items-center gap-2">
                  <SpeakerDot slot={partial.trackNumber + 1} />
                  <span className="text-xs leading-4 font-semibold text-fg">
                    {speakerName(partial.trackNumber)}
                  </span>
                </div>
                <p className="text-sm leading-5 text-fg-muted">{partial.text.trim()}…</p>
              </li>
            ))}
          </ol>
        )}
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
    return { text: "Reconnecting the preview", tone: "waiting" };
  }
  if (tracks.every((track) => track.state === "connecting")) {
    return { text: "Connecting", tone: "muted" };
  }
  return null;
}
