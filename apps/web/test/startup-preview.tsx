import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ChatComposer, MessageTimeline, useComposer, buildTimeline } from "@opengeni/react";
import type { TimelineItem } from "@opengeni/react";
import type { Session, SessionEvent } from "@opengeni/sdk";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../../../packages/react/test/fake-client";
import { useSessionStartupTimeline } from "../src/lib/session-startup-timeline";
import { SessionWaitStatus } from "../src/components/session/session-wait-status";
import { Button } from "../src/components/ui/button";
import "../src/styles.css";

// Production presentation with synthetic, locally controlled lifecycle events.
const params = new URLSearchParams(location.search);
const initial = params.get("state") ?? "accepted";
const acceptedAt = new Date(Date.now() - Number(params.get("age") ?? 0) * 1000).toISOString();
const client = fakeClient({});
function event(
  type: string,
  payload: Record<string, unknown> = {},
  occurredAt = acceptedAt,
): SessionEvent {
  return {
    id: `preview-${type}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    turnId: "turn",
    type,
    payload,
    occurredAt,
  } as SessionEvent;
}
const accepted = event("turn.queued", { routing: "accepted_for_execution" });
const prompt: TimelineItem = {
  kind: "user-message",
  id: "prompt",
  text: "Help me plan the next release.",
  resources: [],
  tools: [],
  occurredAt: acceptedAt,
};
function Preview() {
  const [state, setState] = useState(initial);
  const composer = useComposer(SESSION_ID, {
    client,
    workspaceId: WORKSPACE_ID,
    draftPersistence: "disabled",
    initialPolicy: { model: "sample-model", reasoningEffort: "medium", latencyMode: "standard" },
  });
  const claimed = ["claimed", "working", "failure", "response"].includes(state);
  const events = [
    ...(state === "machine" ? [] : [accepted]),
    ...(claimed ? [event("turn.started", {}, new Date().toISOString())] : []),
  ];
  const items: TimelineItem[] = [prompt, ...buildTimeline(events)];
  if (state === "working")
    items.push({
      kind: "reasoning",
      id: "thought",
      turnId: "turn",
      text: "Reviewing the release requirements",
      streaming: true,
      occurredAt: new Date().toISOString(),
    });
  if (state === "response" || state === "failure")
    items.push({
      kind: "startup-phase",
      id: "phase",
      turnId: "turn",
      phase: state === "failure" ? "sandbox" : "provider_first_byte",
      status: state === "failure" ? "failed" : "running",
      startedAt: acceptedAt,
      occurredAt: acceptedAt,
      completedAt: null,
      durationMs: null,
      outcome: null,
    });
  const session = {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    lastSequence: 0,
    queueVersion: 0,
    updatedAt: acceptedAt,
    status: state === "deliberate" ? "idle" : claimed ? "running" : "queued",
    activeTurnId: claimed ? "turn" : state === "queued" ? "earlier" : null,
    effectiveControl: { state: state === "paused" ? "paused" : "active" },
    inputWait:
      state === "deliberate"
        ? { reason: "Waiting for checks to finish", deadlineAt: "2099-01-01T12:00:00Z" }
        : null,
    dispatchWait: {
      state: state === "error" ? "pending" : "acknowledged",
      attempts: state === "error" ? 2 : 1,
      nextAttemptAt: state === "error" ? "2099-01-01T12:00:00Z" : null,
      lastError: state === "error" ? "Worker temporarily unavailable" : null,
    },
  } as Session;
  const timeline = useSessionStartupTimeline(items, {
    session,
    events,
    optimisticMessages: [],
    hasNewer: false,
  });
  return (
    <main className="flex h-dvh flex-col bg-canvas text-fg">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-xs text-fg-muted">
        <span>Startup preview · synthetic events</span>
        {[
          "accepted",
          "claimed",
          "working",
          "error",
          "paused",
          "queued",
          "response",
          "failure",
          "deliberate",
        ].map((value) => (
          <Button key={value} size="sm" variant="ghost" onClick={() => setState(value)}>
            {value}
          </Button>
        ))}
      </header>
      <MessageTimeline
        className="min-h-0 flex-1"
        turnSummary={{ rolling: true }}
        items={timeline}
      />
      <SessionWaitStatus session={session} />
      <div className="mx-auto w-full max-w-3xl px-4 pb-6">
        <ChatComposer composer={composer} placeholder="Send a follow-up…" />
      </div>
    </main>
  );
}
const root = createRootRoute({ component: Preview });
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
