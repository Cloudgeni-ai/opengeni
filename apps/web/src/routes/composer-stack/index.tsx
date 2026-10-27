// DEV-only full-height preview of the session column: the production
// MessageTimeline, the status row above the composer and the composer, with
// the same wrappers as the session route.
// Open: http://127.0.0.1:3000/dev/composer-stack?state=all&theme=dark
//   state = idle | running | waiting | all   (all = waiting + command + goal + attachment)
//   theme = dark | light
// Screenshots and measurements for the composer-stack design review use this page.
import { MessageTimeline, SessionChrome, type ComposerState } from "@opengeni/react";
import { labScenarios } from "@opengeni/react/testing";
import { useMemo } from "react";

import { galleryQueue, idleComposer } from "@/dev/composer-chrome-fixtures";

import {
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
  const events = useMemo(
    () => labScenarios().find((entry) => entry.id === (running ? "working" : "long"))!.events,
    [running],
  );

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
