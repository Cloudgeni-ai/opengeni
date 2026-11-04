// DEV-only full-height preview of the session column: the production
// MessageTimeline, the status row above the composer and the composer, with
// the same wrappers as the session route.
// Open: http://127.0.0.1:3000/dev/composer-stack?state=all&theme=dark
//   state = idle | running | paused | waiting | all   (all = waiting + command + goal + attachment)
//   theme = dark | light
//   desktop = macos | windows   (the desktop shell's platform attribute)
// Screenshots and measurements for the composer-stack design review use this page.
import {
  MessageTimeline,
  SessionChrome,
  timelineLivePause,
  type ComposerState,
} from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { labScenarios } from "@opengeni/react/testing";
import { useMemo } from "react";

import { galleryQueue, idleComposer } from "@/dev/composer-chrome-fixtures";

import {
  PREVIEW_PAUSED_AT,
  PreviewComposer,
  previewAttachments,
  previewGoal,
  previewSession,
  previewState,
  usePreviewTheme,
} from "./preview-fixtures";

export function ComposerStackPreviewRoute() {
  usePreviewTheme();
  const state = previewState();
  const session = useMemo(() => previewSession(state), [state]);
  const goal = useMemo(() => previewGoal(state), [state]);
  const queue = useMemo(() => galleryQueue(), []);
  const running = session.status === "running";
  // As on the session route: Pause, Queue and Steer while the agent works,
  // and Pause also while a timed wait can wake the chat.
  const composer = useMemo<ComposerState>(() => idleComposer({ working: running }), [running]);
  const attachments = useMemo(() => previewAttachments(state === "all"), [state]);
  const pendingWake = session.status === "idle" && session.inputWait != null;
  const paused = state === "paused";
  const events = useMemo(() => {
    const scenario = labScenarios().find(
      (entry) => entry.id === (running || paused ? "working" : "long"),
    )!.events;
    return running || paused ? recentWork(scenario, paused) : scenario;
  }, [running, paused]);

  return (
    <main
      className="flex h-dvh w-full flex-col overflow-hidden bg-bg text-fg"
      data-preview-state={state}
    >
      <div data-testid="session-timeline" className="min-h-0 min-w-0 flex-1">
        <MessageTimeline
          className="h-full"
          events={events}
          status={running ? "running" : "idle"}
          pause={timelineLivePause(session.effectiveControl)}
          turnSummary={{ rolling: true }}
        />
      </div>
      <div className="mb-1 w-full shrink-0 px-4 has-[>div:empty]:hidden sm:px-6">
        <div className="mx-auto w-full max-w-3xl" data-preview-status="">
          <SessionChrome
            sessionStatus={session.status}
            wait={session.inputWait && session.status === "idle" ? session.inputWait : null}
            queue={queue}
            composer={composer}
            goal={goal}
            commandsCount={session.backgroundCommandActivity?.count ?? 0}
            commandsPanel={<div className="text-og-xs text-og-fg-muted">bun run build</div>}
          />
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <PreviewComposer
            composer={composer}
            session={session}
            attachments={attachments}
            running={running || pendingWake}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * The working scenario moved to now: its turn started 2m 14s before the pause
 * (or before now while it runs). Paused, it ends with the events Pause records.
 */
function recentWork(events: SessionEvent[], paused: boolean): SessionEvent[] {
  const started = events.find((event) => event.type === "turn.started")!;
  const turnId = started.turnId ?? null;
  const end = paused ? Date.parse(PREVIEW_PAUSED_AT) : Date.now();
  const shift = end - 134_000 - Date.parse(started.occurredAt);
  const moved = events.map((event) => ({
    ...event,
    occurredAt: new Date(Date.parse(event.occurredAt) + shift).toISOString(),
  }));
  if (!paused) return moved;
  const at = new Date(end).toISOString();
  const next = (type: string, payload: unknown, eventTurnId: string | null) => ({
    ...started,
    id: `${started.sessionId}-pause-${type}`,
    sequence: moved.length + 1,
    type,
    payload,
    turnId: eventTurnId,
    occurredAt: at,
  });
  for (const [type, payload, eventTurnId] of [
    ["session.control.paused", { actor: { kind: "user" }, reason: null, revision: 1 }, null],
    ["agent.toolCall.output", { id: "c4", output: "Interrupted by Pause" }, turnId],
    ["turn.recovery.requested", { reason: "session_pause" }, turnId],
    ["session.status.changed", { status: "idle", reason: "paused_recovery_settled" }, null],
  ] as const)
    moved.push(next(type, payload, eventTurnId));
  return moved;
}
