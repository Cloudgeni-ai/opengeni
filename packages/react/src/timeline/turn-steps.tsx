import { useEffect, useRef, useState } from "react";
import { useOpenGeniText } from "../messages/runtime";
import type { TurnStepsItem } from "./types";

/**
 * Loads an opened turn's steps. Mounted only inside an open work row, so a
 * turn's steps are read when a reader opens it, newest first, and kept while
 * it stays open. A row that opens by itself (`autoLoad={false}`, for example
 * a failed turn or one with an image) waits for the reader to ask.
 */
export function TurnStepsLoader({
  steps,
  autoLoad = true,
}: {
  steps: TurnStepsItem;
  autoLoad?: boolean | undefined;
}) {
  const { state, load, retain } = steps;
  const [requested, setRequested] = useState(autoLoad);
  useEffect(() => (requested ? retain() : undefined), [requested, retain]);
  useEffect(() => {
    if (requested && state === "idle") load();
  }, [requested, state, load]);
  const ask = () => {
    setRequested(true);
    if (state !== "idle") load();
  };
  return <TurnStepsStatus steps={steps} onLoad={requested ? undefined : ask} />;
}

/**
 * Timelines without readable turn rows place this at the turn's start: its
 * steps load when the reader asks, and are kept from then on.
 */
export function TurnStepsAction({ steps }: { steps: TurnStepsItem }) {
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);
  const load = () => {
    release.current ??= steps.retain();
    steps.load();
  };
  return <TurnStepsStatus steps={steps} onLoad={load} />;
}

function TurnStepsStatus({
  steps,
  onLoad,
}: {
  steps: TurnStepsItem;
  onLoad?: (() => void) | undefined;
}) {
  const t = useOpenGeniText();
  const { state } = steps;
  const load = onLoad ?? steps.load;
  if (state === "complete") return null;
  // An opened row loads by itself; elsewhere the reader asks.
  if (state === "partial" || (state === "idle" && onLoad)) {
    return (
      <div data-og-turn-steps={state} className="py-1">
        <button
          type="button"
          onClick={load}
          className="rounded-og-sm px-1.5 py-0.5 text-og-sm text-og-fg-subtle transition-colors hover:bg-og-surface-1 hover:text-og-fg"
        >
          {state === "idle"
            ? t("timeline.turnSteps.showSteps")
            : t("timeline.turnSteps.showEarlierSteps")}
        </button>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div data-og-turn-steps="error" className="flex items-center gap-2 py-1 text-og-sm">
        <span className="text-og-fg-subtle">{t("timeline.turnSteps.couldNotLoadSteps")}</span>
        <button
          type="button"
          onClick={load}
          className="rounded-og-sm px-1.5 py-0.5 text-og-fg-muted transition-colors hover:bg-og-surface-1 hover:text-og-fg"
        >
          {t("timeline.turnSteps.retry")}
        </button>
      </div>
    );
  }
  return (
    <div
      data-og-turn-steps="loading"
      role="status"
      className="animate-og-pulse py-1 text-og-sm text-og-fg-subtle motion-reduce:animate-none"
    >
      {t("timeline.turnSteps.loadingSteps")}
    </div>
  );
}
