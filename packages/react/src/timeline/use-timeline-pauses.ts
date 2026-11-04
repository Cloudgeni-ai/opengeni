import type { SessionEvent } from "@opengeni/sdk";
import { useMemo, useState } from "react";
import { timelinePauseSpans, type TimelineLivePause, type TimelinePauseSpan } from "./projection";

/** At most this many pauses seen only through the live control are kept. */
const OBSERVED_PAUSE_LIMIT = 20;

type LivePauseHistory = {
  sessionId: string | null;
  /** The live pause as last rendered; undefined while it is unknown. */
  live: boolean | undefined;
  /** The last known pause state: a brief unknown does not forget a pause. */
  paused: boolean | undefined;
  /** When the pause in force began, as best known. */
  since: string | null;
  /** When this view saw the latest pause end. */
  resumedAt: string | null;
  /** Pauses this view saw begin and end. */
  observed: TimelinePauseSpan[];
};

function nextHistory(
  previous: LivePauseHistory | null,
  sessionId: string | null,
  paused: boolean | undefined,
  since: string | null,
  now: string,
): LivePauseHistory {
  if (!previous || previous.sessionId !== sessionId) {
    return {
      sessionId,
      live: paused,
      paused,
      since: paused ? (since ?? now) : null,
      resumedAt: null,
      observed: [],
    };
  }
  if (paused === undefined) return { ...previous, live: paused };
  if (previous.paused === true && paused === false) {
    return {
      ...previous,
      live: paused,
      paused,
      since: null,
      resumedAt: now,
      observed: [...previous.observed, { startedAt: previous.since ?? now, endedAt: now }].slice(
        -OBSERVED_PAUSE_LIMIT,
      ),
    };
  }
  if (paused === true && previous.paused !== true) {
    return { ...previous, live: paused, paused, since: since ?? now, resumedAt: null };
  }
  return { ...previous, live: paused, paused };
}

/**
 * The session's pause spans for `groupTimeline`, from its events and its live
 * pause (`timelineLivePause(session.effectiveControl)`).
 *
 * A pause that held a waiting turn, or an ancestor's pause of a turn it did
 * not interrupt, leaves no events, so this view remembers the pauses it saw
 * through the live control. It also notes the moment it saw a pause end, so
 * the paused time never counts as work while the resume's events arrive.
 */
export function useTimelinePauses(
  events: readonly SessionEvent[] | undefined,
  pause: TimelineLivePause | null | undefined,
  enabled = true,
): TimelinePauseSpan[] {
  const paused = pause?.paused;
  const since = pause?.since ?? null;
  const sessionId = events?.[0]?.sessionId ?? null;
  const [stored, setStored] = useState<LivePauseHistory | null>(null);
  let history = stored;
  if (!history || history.sessionId !== sessionId || history.live !== paused) {
    // Derived during render so the first render after a flip is already right.
    history = nextHistory(stored, sessionId, paused, since, new Date().toISOString());
    setStored(history);
  }
  // While the control is briefly unknown, the last known pause stays in force.
  const livePaused = paused ?? (history.paused === true ? true : undefined);
  const historySince = history.since;
  const historyResumedAt = history.resumedAt;
  const observed = history.observed;
  const resumedAt = pause?.resumedAt ?? null;
  return useMemo(
    () =>
      enabled
        ? timelinePauseSpans(
            events ?? [],
            livePaused === undefined
              ? undefined
              : {
                  paused: livePaused,
                  since: since ?? historySince,
                  resumedAt: resumedAt ?? historyResumedAt,
                },
            observed,
          )
        : [],
    [enabled, events, livePaused, since, historySince, resumedAt, historyResumedAt, observed],
  );
}
