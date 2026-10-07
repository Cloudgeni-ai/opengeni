import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageTimeline } from "@opengeni/react/session-ui";
import type { SessionEvent } from "@opengeni/sdk";
import "./styles.css";

/*
 * Agent rows: spawning, messaging, and hearing from other agents, replayed
 * through the production MessageTimeline. `?titles=0` drops the host title
 * resolver to show the spawn-title and generic fallbacks; `?theme=light`
 * switches from the default dark theme.
 */

const AUDIT = "7f3c2a91-4b5d-4e6f-8a7b-9c0d1e2f3a4b";
const FLAKE = "b18e0d44-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const LIVE_TITLES: Record<string, string> = {
  [AUDIT]: "API audit",
  [FLAKE]: "Checkout e2e flake",
};

function scenario(): SessionEvent[] {
  const events: SessionEvent[] = [];
  let at = Date.parse("2026-10-07T18:29:00Z");
  const add = (type: string, payload: unknown, turnId: string | null, seconds = 1) => {
    at += seconds * 1000;
    events.push({
      id: `evt-${events.length + 1}`,
      workspaceId: "ws-demo",
      sessionId: "session-demo",
      sequence: events.length + 1,
      type,
      payload,
      occurredAt: new Date(at).toISOString(),
      turnId,
    });
  };
  const call = (id: string, name: string, args: unknown, output: unknown, turnId: string) => {
    add("agent.toolCall.created", { id, name, arguments: args }, turnId);
    add("agent.toolCall.output", { id, output }, turnId, 2);
  };

  add(
    "user.message",
    {
      text: "Get 2.4 ready to ship: audit the public API changes and fix the flaky checkout e2e test.",
    },
    null,
  );
  add("turn.started", {}, "turn-1");
  call("log", "exec_command", { cmd: "git log v2.3..main --oneline" }, "42 commits", "turn-1");
  call(
    "spawn-audit",
    "opengeni__session_create",
    {
      title: "API audit",
      initialMessage:
        "Diff the public SDK surface between v2.3 and main and flag every breaking change with a migration note. Report progress after the core client package.",
    },
    { structuredContent: { sessionId: AUDIT, status: "queued" } },
    "turn-1",
  );
  call(
    "spawn-flake",
    "opengeni__session_create",
    {
      title: "Checkout e2e flake",
      initialMessage:
        "Reproduce the intermittent checkout.spec failure and land a real fix, not a retry. Ask before changing timeouts.",
    },
    { structuredContent: { sessionId: FLAKE, status: "queued" } },
    "turn-1",
  );
  add(
    "agent.message.completed",
    { text: "Both are running. I'll review their results as they come in.", phase: "final_answer" },
    "turn-1",
  );
  add("turn.completed", {}, "turn-1");

  add(
    "system.update.delivered",
    {
      members: [
        {
          id: "u-1",
          kind: "agent_message",
          classification: "info",
          sourceId: AUDIT,
          summary:
            'Two breaking changes so far: Client.listRuns() now returns a cursor page instead of an array, and RunEvent.kind no longer emits "tool_start". Moving on to the webhooks package.',
        },
      ],
    },
    "turn-2",
    700,
  );
  add("turn.started", {}, "turn-2");
  add(
    "agent.message.completed",
    { text: "Noted. Two breaking changes so far; waiting for the rest.", phase: "final_answer" },
    "turn-2",
  );
  add("turn.completed", {}, "turn-2");

  add(
    "system.update.delivered",
    {
      members: [
        {
          id: "u-2",
          kind: "child_progress",
          classification: "info",
          sourceId: FLAKE,
          summary: `Worker ${FLAKE} progress: Reproduced 4/20 failures at 2x CPU throttle.`,
        },
        {
          id: "u-3",
          kind: "child_progress",
          classification: "info",
          sourceId: FLAKE,
          summary: `Worker ${FLAKE} progress: Root cause: the confirm step races a 5s timeout.`,
        },
        {
          id: "u-4",
          kind: "child_requires_action",
          classification: "action_required",
          sourceId: FLAKE,
          summary: `Worker ${FLAKE} is blocked and needs input (turn ${FLAKE}). It asked: OK to raise the confirm timeout to 15s, or should I wait on the confirm event explicitly?.`,
        },
        {
          id: "u-5",
          kind: "child_terminal_result",
          classification: "success",
          sourceId: AUDIT,
          summary: [
            `A worker session you spawned has COMPLETED its goal. Worker session id: ${AUDIT}.`,
            "Worker goal: Diff the public SDK surface between v2.3 and main",
            "Completion evidence: 3 breaking changes, each with a migration snippet in docs/migrating-2.4.md",
          ].join("\n"),
        },
        {
          id: "u-6",
          kind: "session_wait_timeout",
          classification: "info",
          sourceId: "wait-1",
          summary: "The wait for agents ended after 30 minutes.",
        },
      ],
    },
    "turn-3",
    360,
  );
  add("turn.started", {}, "turn-3");
  call(
    "message-flake",
    "opengeni__session_send_message",
    {
      sessionId: FLAKE,
      text: "Don't raise the timeout. Wait on the confirm event explicitly and run the spec 50 times before reporting back.",
    },
    { structuredContent: { sessionId: FLAKE } },
    "turn-3",
  );
  add(
    "agent.message.completed",
    {
      text: "Use the explicit wait; it fixes the race instead of hiding it.",
      phase: "final_answer",
    },
    "turn-3",
  );
  add("turn.completed", {}, "turn-3");
  return events;
}

const EVENTS = scenario();
const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "light") document.documentElement.dataset.ogTheme = "light";
const withTitles = params.get("titles") !== "0";
const resolveSessionTitle = (sessionId: string) => LIVE_TITLES[sessionId] ?? null;

function Harness() {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col bg-og-bg text-og-fg">
      <p className="px-4 py-2 text-og-sm text-og-fg-subtle" data-testid="opened">
        {opened ? `Opened ${LIVE_TITLES[opened] ?? opened}` : "No session opened"}
      </p>
      <MessageTimeline
        className="min-h-0 flex-1"
        events={EVENTS}
        onOpenSession={setOpened}
        {...(withTitles ? { resolveSessionTitle } : {})}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
