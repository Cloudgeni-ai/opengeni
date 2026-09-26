import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageTimeline } from "@opengeni/react/session-ui";
import type { SessionEvent } from "@opengeni/sdk";
import "./styles.css";

/*
 * Exchange fold studio: one delegated question replayed through the
 * production MessageTimeline. Compare the compact presentation (one status row
 * per exchange, answer below a "Worked for" separator) with the classic
 * grouping, in both themes, at any viewport width.
 */

type Draft = { type: string; payload: unknown; turnId: string | null; at: number };

/** Deterministic driver for the browser regression suite. */
type ExchangeFoldHarness = {
  total: number;
  /** Show the first `count` events of the scripted exchange. */
  show(count: number): void;
};

declare global {
  interface Window {
    exchangeFoldHarness?: ExchangeFoldHarness;
  }
}

const WORKER = "5f0c1a2e-7b3d-4c8e-9a61-2d4e6f8a0b1c";
const ANSWER = [
  "**312 new users** signed up in the last 48 hours, up 18% on the previous 48 hours.\n\n",
  "| Window | Signups | Verified |\n| --- | --- | --- |\n",
  "| Last 24 h | 171 | 149 |\n| 24 to 48 h ago | 141 | 126 |\n\n",
  "Most signups came from the docs site (58%). ",
  "Verification stays at 88%, so no drop-off to chase right now.",
];

function scenario(): Draft[] {
  const drafts: Draft[] = [];
  let at = 0;
  const add = (type: string, payload: unknown, turnId: string | null, gap = 1) => {
    at += gap;
    drafts.push({ type, payload, turnId, at });
  };
  const tool = (id: string, name: string, args: unknown, output: unknown, turnId: string) => {
    add("agent.toolCall.created", { id, name, arguments: args }, turnId, 2);
    add("agent.toolCall.output", { id, output }, turnId, 5);
  };
  add("user.message", { text: "How many new users signed up in the last 48 hours?" }, null);
  add("turn.started", {}, "turn-1", 2);
  add("agent.message.delta", { text: "I'll run the signup query in a worker." }, "turn-1", 6);
  tool("skill", "skill_read", { name: "analytics" }, "Loaded analytics.", "turn-1");
  add(
    "agent.toolCall.created",
    {
      id: "spawn",
      name: "opengeni__session_create",
      arguments: { initialMessage: "Count signups for the last 48 hours." },
    },
    "turn-1",
    8,
  );
  add("agent.toolCall.output", { id: "spawn", output: { sessionId: WORKER } }, "turn-1", 3);
  tool("wait-1", "opengeni__session_wait", { sessionId: WORKER }, { timedOut: true }, "turn-1");
  tool("get-1", "opengeni__session_get", { sessionId: WORKER }, { status: "running" }, "turn-1");
  add(
    "agent.message.delta",
    { text: "The worker is still running the query; I'll wait for its result." },
    "turn-1",
    7,
  );
  add(
    "agent.toolCall.created",
    { id: "park", name: "wait_for_input", arguments: { reason: "worker running" } },
    "turn-1",
    4,
  );
  add(
    "session.wait.started",
    { actor: "agent", reason: "Waiting for the signup worker.", waitTurnId: "turn-1" },
    "turn-1",
  );
  add("agent.toolCall.output", { id: "park", output: { status: "waiting_for_input" } }, "turn-1");
  add("turn.completed", { output: "" }, "turn-1");
  add(
    "system.update.delivered",
    {
      members: [
        {
          id: "result",
          kind: "child_terminal_result",
          classification: "success",
          sourceId: WORKER,
          summary: "A worker session you spawned has COMPLETED its goal.",
        },
      ],
    },
    "turn-2",
    95,
  );
  add("turn.started", {}, "turn-2", 6);
  tool("events", "opengeni__session_events", { sessionId: WORKER }, "312 signups", "turn-2");
  tool(
    "check",
    "exec_command",
    {
      cmd: "psql -c \"select count(*) from users where created_at > now() - interval '48 hours'\"",
    },
    "312",
    "turn-2",
  );
  for (const chunk of ANSWER) {
    add("agent.message.delta", { text: chunk, messageId: "answer" }, "turn-2", 2);
  }
  add(
    "agent.message.completed",
    { text: ANSWER.join(""), messageId: "answer", phase: "final_answer" },
    "turn-2",
  );
  add("turn.completed", {}, "turn-2");
  add("user.message", { text: "And yesterday alone?" }, null, 20);
  add("turn.started", {}, "turn-3", 2);
  tool("yesterday", "exec_command", { cmd: "psql -f yesterday.sql" }, "171", "turn-3");
  add(
    "agent.message.completed",
    { text: "171 users signed up yesterday.", phase: "final_answer" },
    "turn-3",
    3,
  );
  add("turn.completed", {}, "turn-3");
  return drafts;
}

const STAGES = [
  { label: "Working", type: "agent.toolCall.created", id: "get-1" },
  { label: "Waiting", type: "turn.completed", turn: "turn-1" },
  { label: "Resumed", type: "agent.toolCall.created", id: "check" },
  { label: "Answering", type: "agent.message.delta", nth: 3 },
  { label: "Done", type: "turn.completed", turn: "turn-2" },
  { label: "Follow-up", type: "turn.completed", turn: "turn-3" },
] as const;

const BUTTON =
  "rounded-lg border border-og-border px-3 py-1.5 text-og-sm text-og-fg-muted transition hover:bg-og-surface-2 aria-pressed:bg-og-surface-2 aria-pressed:text-og-fg";

function App() {
  const drafts = useMemo(scenario, []);
  const [count, setCount] = useState(0);
  const [dark, setDark] = useState(true);
  const [compact, setCompact] = useState(true);
  const [playing, setPlaying] = useState(false);
  const epoch = useRef(Date.now());
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    window.exchangeFoldHarness = {
      total: drafts.length,
      show: (value) => {
        setPlaying(false);
        setCount(value);
      },
    };
    return () => {
      delete window.exchangeFoldHarness;
    };
  }, [drafts.length]);
  useEffect(() => {
    if (!playing) return;
    if (count >= drafts.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setCount((value) => value + 1), 450);
    return () => window.clearTimeout(timer);
  }, [playing, count, drafts.length]);
  const stageCount = (index: number) => {
    const stage = STAGES[index]!;
    let seen = 0;
    const position = drafts.findIndex((draft) => {
      if (draft.type !== stage.type) return false;
      const payload = draft.payload as { id?: string };
      if ("id" in stage) return payload.id === stage.id;
      if ("turn" in stage) return draft.turnId === stage.turn;
      seen += draft.turnId === "turn-2" ? 1 : 0;
      return draft.turnId === "turn-2" && seen === stage.nth;
    });
    return position + 1;
  };
  // Timestamps end "now", so live clocks read like a real exchange.
  const events = useMemo<SessionEvent[]>(() => {
    const shown = drafts.slice(0, count);
    const last = shown.at(-1)?.at ?? 0;
    return shown.map((draft, index) => ({
      id: `exchange-${index + 1}`,
      workspaceId: "demo",
      sessionId: "exchange-fold",
      sequence: index + 1,
      type: draft.type,
      payload: draft.payload,
      turnId: draft.turnId,
      occurredAt: new Date(epoch.current - (last - draft.at) * 1000).toISOString(),
    }));
  }, [drafts, count]);
  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col px-4 py-4 sm:px-8">
      <header className="flex flex-wrap items-center gap-2 border-b border-og-border pb-3">
        <span className="mr-2 text-og-sm font-medium">Exchange fold</span>
        {STAGES.map((stage, index) => (
          <button
            key={stage.label}
            className={BUTTON}
            aria-pressed={count === stageCount(index)}
            onClick={() => {
              setPlaying(false);
              setCount(stageCount(index));
            }}
          >
            {stage.label}
          </button>
        ))}
        <button
          className={BUTTON}
          aria-pressed={playing}
          onClick={() => {
            setCount(1);
            setPlaying(true);
          }}
        >
          Play
        </button>
        <span className="ml-auto flex gap-2">
          <button className={BUTTON} aria-pressed={!compact} onClick={() => setCompact(!compact)}>
            {compact ? "Compact" : "Classic"}
          </button>
          <button className={BUTTON} onClick={() => setDark(!dark)}>
            {dark ? "Dark" : "Light"}
          </button>
        </span>
      </header>
      <section aria-label="Conversation" className="min-h-0 flex-1">
        <MessageTimeline
          key={compact ? "compact" : "classic"}
          className="h-full"
          events={events}
          turnSummary={{ rolling: compact }}
          onOpenSession={() => undefined}
        />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
