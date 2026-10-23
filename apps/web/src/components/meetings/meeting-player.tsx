/**
 * Plays a meeting's tracks together: the microphone and the shared audio are
 * separate files, so one control drives every <audio> element and keeps the
 * followers within a quarter second of the first track.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";

import { Button } from "@opengeni/react/ui/button";
import { cn } from "@opengeni/react/app/lib/utils";

import { formatClock } from "./meeting-model";

export type MeetingPlayerHandle = {
  /** Jump to a moment and play from there. */
  playFrom: (milliseconds: number) => void;
};

export type MeetingPlayerSource = { trackNumber: number; url: string };

const RATES = [1, 1.25, 1.5, 2] as const;
const MAX_DRIFT_SECONDS = 0.25;

export const MeetingPlayer = forwardRef<
  MeetingPlayerHandle,
  {
    sources: MeetingPlayerSource[];
    /** Known length, shown before the audio's own metadata loads. */
    durationMilliseconds: number;
    /** Called about four times a second while playing, and on every seek. */
    onTime?: ((milliseconds: number) => void) | undefined;
    /** A track's link expired or failed; the parent fetches fresh links. */
    onSourceError?: (() => void) | undefined;
    className?: string | undefined;
  }
>(function MeetingPlayer({ sources, durationMilliseconds, onTime, onSourceError, className }, ref) {
  const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationMilliseconds / 1000);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  const elements = useCallback(
    () =>
      sources
        .map((source) => audioRefs.current.get(source.trackNumber))
        .filter((element): element is HTMLAudioElement => Boolean(element)),
    [sources],
  );
  const leader = useCallback(() => elements()[0] ?? null, [elements]);

  const seek = useCallback(
    (seconds: number) => {
      for (const element of elements()) element.currentTime = seconds;
      setCurrent(seconds);
      onTimeRef.current?.(seconds * 1000);
    },
    [elements],
  );
  const play = useCallback(() => {
    const lead = leader();
    for (const element of elements()) {
      if (lead && element !== lead) element.currentTime = lead.currentTime;
      void element.play().catch(() => setPlaying(false));
    }
    setPlaying(true);
  }, [elements, leader]);
  const pause = useCallback(() => {
    for (const element of elements()) element.pause();
    setPlaying(false);
  }, [elements]);

  useImperativeHandle(
    ref,
    () => ({
      playFrom: (milliseconds: number) => {
        seek(milliseconds / 1000);
        play();
      },
    }),
    [play, seek],
  );

  useEffect(() => {
    for (const element of elements()) element.playbackRate = rate;
  }, [elements, rate]);

  // Follow the leader: time display, transcript highlight and drift correction.
  useEffect(() => {
    const lead = leader();
    if (!lead) return;
    let last = 0;
    const update = () => {
      const now = performance.now();
      if (now - last < 240) return;
      last = now;
      setCurrent(lead.currentTime);
      onTimeRef.current?.(lead.currentTime * 1000);
      for (const element of elements()) {
        if (
          element !== lead &&
          Math.abs(element.currentTime - lead.currentTime) > MAX_DRIFT_SECONDS
        ) {
          element.currentTime = lead.currentTime;
        }
      }
    };
    const ended = () => pause();
    const metadata = () => {
      const longest = Math.max(
        ...elements().map((element) => (Number.isFinite(element.duration) ? element.duration : 0)),
      );
      if (longest > 0) setDuration(longest);
    };
    lead.addEventListener("timeupdate", update);
    lead.addEventListener("ended", ended);
    for (const element of elements()) element.addEventListener("loadedmetadata", metadata);
    return () => {
      lead.removeEventListener("timeupdate", update);
      lead.removeEventListener("ended", ended);
      for (const element of elements()) element.removeEventListener("loadedmetadata", metadata);
    };
  }, [elements, leader, pause]);

  const total = Math.max(duration, current);
  const progress = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-[14px] border border-border bg-surface px-3 py-2",
        className,
      )}
    >
      {sources.map((source) => (
        <audio
          key={source.trackNumber}
          ref={(element) => {
            if (element) audioRefs.current.set(source.trackNumber, element);
            else audioRefs.current.delete(source.trackNumber);
          }}
          src={source.url}
          preload="metadata"
          onError={() => onSourceError?.()}
        />
      ))}
      <Button
        type="button"
        size="icon-sm"
        onClick={() => (playing ? pause() : play())}
        aria-label={playing ? "Pause" : "Play"}
        className="shrink-0 rounded-full pointer-coarse:size-11"
      >
        {playing ? (
          <PauseIcon aria-hidden="true" className="fill-current" />
        ) : (
          <PlayIcon aria-hidden="true" className="translate-x-px fill-current" />
        )}
      </Button>
      <span className="min-w-9 shrink-0 text-right text-xs leading-4 text-fg-muted tabular-nums">
        {formatClock(current * 1000)}
      </span>
      {/* A native range for keyboard and screen readers, drawn with the palette. */}
      <span className="relative flex h-6 min-w-0 flex-1 items-center pointer-coarse:h-11">
        <input
          type="range"
          min={0}
          max={Math.max(1, total)}
          step={0.1}
          value={current}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Position"
          aria-valuetext={`${formatClock(current * 1000)} of ${formatClock(total * 1000)}`}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
        />
        <span aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full rounded-full bg-brand" style={{ width: `${progress}%` }} />
        </span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_1px_2px_rgb(0_0_0/0.2)] ring-2 ring-surface transition-transform duration-[120ms] peer-hover:scale-125 peer-focus-visible:ring-4 peer-focus-visible:ring-ring/50"
          style={{ left: `${progress}%` }}
        />
      </span>
      <span className="min-w-9 shrink-0 text-xs leading-4 text-fg-muted tabular-nums">
        {formatClock(total * 1000)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]!)}
        aria-label={`Playback speed ${rate}×`}
        className="w-11 shrink-0 rounded-[8px] px-0 text-xs text-fg-muted tabular-nums pointer-coarse:h-11"
      >
        {rate}×
      </Button>
    </div>
  );
});
