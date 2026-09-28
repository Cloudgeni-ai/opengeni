import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageTimeline } from "@opengeni/react/session-ui";
import type { SessionEvent } from "@opengeni/sdk";
import recordedAnswerExchange from "../test/fixtures/exchange-answer-before-machine-turns.json";
import "./styles.css";

/*
 * Readable timeline studio: scripted turns replayed through the production
 * MessageTimeline. Compare the readable per-turn presentation with classic grouping,
 * in both themes, at any viewport width. `?scenario=` picks the script:
 * `delegated` (default), `follow-up`, `notes`, `history`, or
 * `machine-follow-up`. `follow-up`, `notes`, and `history` stream messages the
 * way the runtime records them today: identified deltas without a phase, and a
 * phase-less final output receipt at turn end. `machine-follow-up` replays an
 * anonymized recorded exchange whose answer is followed by one more
 * machine-triggered turn.
 */

type Draft = { type: string; payload: unknown; turnId: string | null; at: number };

/** Deterministic driver for the browser regression suite. */
type ExchangeFoldHarness = {
  total: number;
  /** Show the first `count` events of the scripted exchange. */
  show(count: number): void;
  /**
   * Show events `[start, count)` with older history available before them;
   * loading older history prepends everything before `start`.
   */
  showWindow(start: number, count: number): void;
  /** Indexes of the scripted events of a type whose payload matches. */
  indexOf(type: string, match?: Record<string, unknown>): number[];
  /** Whether the timeline asked for older history since the window was shown. */
  olderRequested(): boolean;
  /** Deliver the older history the timeline asked for. */
  completeOlder(): void;
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

function script() {
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
  /** A message streamed as recorded today: identified, phase-less deltas. */
  const stream = (messageId: string, text: string, turnId: string, chunk = 120) => {
    for (let offset = 0; offset < text.length; offset += chunk) {
      add("agent.message.delta", { text: text.slice(offset, offset + chunk), messageId }, turnId);
    }
  };
  /** The worker's settlement: phase-less final output receipt, then the turn end. */
  const settle = (output: string, turnId: string) => {
    add("agent.message.completed", { text: output }, turnId);
    add("turn.completed", { output }, turnId);
  };
  return { drafts, add, tool, stream, settle };
}

const FOLLOW_UP = [
  "Thanks. Now break the signups down further:",
  "- by signup source (docs, pricing page, referral),",
  "- by verified versus unverified,",
  "- by region for the top three regions,",
  "- and flag anything that looks like a bot burst.",
  "Keep it short, a table is fine.",
].join("\n");

/** A short answered question, then a longer follow-up that works for a while. */
function followUpScenario(): Draft[] {
  const { drafts, add, tool, stream, settle } = script();
  add("user.message", { text: "How many users signed up yesterday?" }, null);
  add("turn.started", {}, "turn-1", 2);
  tool("count", "exec_command", { cmd: "psql -f yesterday.sql" }, "171", "turn-1");
  stream("answer-1", "171 users signed up yesterday.", "turn-1");
  settle("171 users signed up yesterday.", "turn-1");
  add("user.message", { text: FOLLOW_UP }, null, 20);
  add("turn.started", {}, "turn-2", 2);
  stream("note-1", "I'll split yesterday's signups by source, verification, and region.", "turn-2");
  for (const [index, sql] of ["source", "verified", "region", "bursts", "totals"].entries()) {
    tool(`q-${index}`, "exec_command", { cmd: `psql -f ${sql}.sql` }, "ok", "turn-2");
  }
  const table = [
    "| Source | Signups | Verified |\n| --- | --- | --- |\n",
    "| Docs | 99 | 88 |\n| Pricing | 41 | 37 |\n| Referral | 31 | 24 |\n\n",
    "No bot bursts: the busiest minute had 4 signups.",
  ].join("");
  stream("answer-2", table, "turn-2");
  settle(table, "turn-2");
  return drafts;
}

const LONG_NOTE =
  "The signup table mixes three sources, so I'm reconciling them before counting: " +
  "the docs funnel writes a source tag, the pricing page writes a campaign id, and " +
  "referrals only carry the inviter. I'll normalise all three into one column, then " +
  "check that the totals still match yesterday's raw count before breaking it down. ";

const OVERSIZED_NOTE = `${LONG_NOTE.repeat(4)}That is the whole plan; running it now.`;

/** A long turn of delta-only progress notes, as the runtime streams them today. */
function notesScenario(): Draft[] {
  const { drafts, add, tool, stream, settle } = script();
  add("user.message", { text: "Break down yesterday's signups by source." }, null);
  add("turn.started", {}, "turn-1", 2);
  tool("schema", "exec_command", { cmd: "psql -c '\\d users'" }, "ok", "turn-1");
  for (let index = 0; index < 3; index += 1) {
    stream(`note-${index}`, LONG_NOTE, "turn-1", 60);
    tool(`step-${index}`, "exec_command", { cmd: `psql -f step-${index}.sql` }, "ok", "turn-1");
  }
  stream("note-oversized", OVERSIZED_NOTE, "turn-1", 200);
  tool("verify", "exec_command", { cmd: "psql -f verify.sql" }, "ok", "turn-1");
  const reply = "Docs 99, pricing 41, referral 31: 171 in total, matching the raw count.";
  stream("answer", reply, "turn-1");
  settle(reply, "turn-1");
  return drafts;
}

/** Long real work details plus following prose exercise section-scoped sticky headers. */
function stickyScenario(): Draft[] {
  const { drafts, add, tool, stream, settle } = script();
  add(
    "user.message",
    { text: "Verify the signup analysis and have two agents check the results." },
    null,
  );
  add("turn.started", {}, "turn-sticky");
  for (let worker = 0; worker < 2; worker++) {
    tool(
      `worker-${worker}`,
      "opengeni__session_create",
      { initialMessage: "Verify signup totals." },
      { sessionId: worker === 0 ? WORKER : "6f0c1a2e-7b3d-4c8e-9a61-2d4e6f8a0b1c" },
      "turn-sticky",
    );
  }
  for (let step = 0; step < 40; step++) {
    if (step % 12 === 0)
      stream(
        `progress-${step}`,
        `Checking batch ${step / 12 + 1}: **reconcile** source totals and verification counts.`,
        "turn-sticky",
      );
    tool(
      `verify-${step}`,
      "exec_command",
      { cmd: `psql -f signup-check-${step + 1}.sql` },
      "Counts match the source ledger.",
      "turn-sticky",
    );
  }
  add(
    "session.wait.started",
    { actor: "agent", reason: "Waiting for both signup checks.", waitTurnId: "turn-sticky" },
    "turn-sticky",
  );
  add("turn.completed", { output: "" }, "turn-sticky");
  add("user.message", { text: "Show the verified breakdown." }, null, 20);
  add("turn.started", {}, "turn-answer");
  const answer = Array.from(
    { length: 16 },
    (_, index) =>
      `### Verified batch ${index + 1}\n\nThe source totals match. All verification counts reconcile against the signup ledger; no duplicate records were found.`,
  ).join("\n\n");
  stream("sticky-answer", answer, "turn-answer");
  settle(answer, "turn-answer");
  return drafts;
}

/** Several exchanges, so a window that starts inside one can load older history. */
function historyScenario(): Draft[] {
  const { drafts, add, tool, stream, settle } = script();
  for (let exchange = 1; exchange <= 4; exchange += 1) {
    const turnId = `turn-${exchange}`;
    add(
      "user.message",
      { text: `Question ${exchange}: how did signups move this week?` },
      null,
      30,
    );
    add("turn.started", {}, turnId, 2);
    stream(`note-${exchange}`, `Checking week ${exchange} against the week before.`, turnId);
    for (let step = 0; step < 4; step += 1) {
      tool(
        `q-${exchange}-${step}`,
        "exec_command",
        { cmd: `psql -f w${exchange}-${step}.sql` },
        "ok",
        turnId,
      );
    }
    const reply = [
      `**Week ${exchange}:** ${140 + exchange * 7} signups, up ${exchange + 2}% on the week before.`,
      "",
      "| Day | Signups |",
      "| --- | --- |",
      ...["Mon", "Tue", "Wed", "Thu", "Fri"].map(
        (day, index) => `| ${day} | ${20 + index + exchange} |`,
      ),
    ].join("\n");
    stream(`answer-${exchange}`, reply, turnId);
    settle(reply, turnId);
  }
  return drafts;
}

function delegatedScenario(): Draft[] {
  const { drafts, add, tool } = script();
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

/**
 * A recorded exchange (anonymized): the answer settles, then an agent message
 * starts one more short turn that ends without prose.
 */
function machineFollowUpScenario(): Draft[] {
  const recorded = recordedAnswerExchange as SessionEvent[];
  const start = Date.parse(recorded[0]!.occurredAt);
  return recorded.map((event) => ({
    type: event.type,
    payload: event.payload,
    turnId: event.turnId ?? null,
    at: (Date.parse(event.occurredAt) - start) / 1000,
  }));
}

const SCENARIOS: Record<string, () => Draft[]> = {
  delegated: delegatedScenario,
  "follow-up": followUpScenario,
  notes: notesScenario,
  history: historyScenario,
  sticky: stickyScenario,
  "review-maintenance": () => {
    const { drafts, add } = script();
    add("user.message", { text: "Check the signup totals." }, null);
    add(
      "agent.message.completed",
      { text: "The signup totals reconcile.", phase: "final_answer" },
      "turn-1",
    );
    add("turn.started", {}, "maintenance");
    add("session.context.compaction.started", { trigger: "operator" }, "maintenance");
    add(
      "session.context.compacted",
      { trigger: "operator", estimatedTokensBefore: 240000, estimatedTokensAfter: 40000 },
      "maintenance",
    );
    add("turn.completed", { maintenance: "context_compaction" }, "maintenance");
    add("session.status.changed", { status: "idle" }, "maintenance");
    return drafts;
  },
  "review-approval": () => {
    const { drafts, add } = script();
    add("user.message", { text: "Verify the signup totals with the approved query." }, null);
    add("turn.started", {}, "turn-1");
    add(
      "agent.toolCall.created",
      { id: "same", name: "exec_command", arguments: { cmd: "psql -f signup-totals.sql" } },
      "turn-1",
    );
    add("session.requiresAction", {}, "turn-1");
    add("session.status.changed", { status: "requires_action" }, null);
    add("session.status.changed", { status: "running" }, null);
    add("agent.toolCall.output", { id: "same", output: "Approved query: 312 signups." }, "turn-1");
    add(
      "agent.message.delta",
      {
        text: "The approved query completed. I’m **reconciling the source breakdown** now.",
        phase: "commentary",
      },
      "turn-1",
    );
    return drafts;
  },
  "machine-follow-up": machineFollowUpScenario,
};

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
  const scenarioName = new URLSearchParams(window.location.search).get("scenario") ?? "delegated";
  const drafts = useMemo(() => (SCENARIOS[scenarioName] ?? delegatedScenario)(), [scenarioName]);
  const [count, setCount] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [historyMode, setHistoryMode] = useState(false);
  // The regression suite delivers older history on demand, so it can measure
  // the reader's position right before the prepend lands.
  const deferOlder = useRef(false);
  const olderRequested = useRef(false);
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
        setHistoryMode(false);
        setPlaying(false);
        setWindowStart(0);
        setCount(value);
      },
      showWindow: (start, value) => {
        setHistoryMode(true);
        setPlaying(false);
        deferOlder.current = true;
        olderRequested.current = false;
        setWindowStart(start);
        setCount(value);
      },
      olderRequested: () => olderRequested.current,
      completeOlder: () => setWindowStart(0),
      indexOf: (type, match = {}) =>
        drafts.flatMap((draft, index) =>
          draft.type === type &&
          Object.entries(match).every(
            ([key, value]) => (draft.payload as Record<string, unknown>)[key] === value,
          )
            ? [index]
            : [],
        ),
    };
    return () => {
      delete window.exchangeFoldHarness;
    };
  }, [drafts]);
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
    const last = drafts.at(-1)?.at ?? 0;
    return shown.slice(windowStart).map((draft, offset) => ({
      id: `exchange-${windowStart + offset + 1}`,
      workspaceId: "demo",
      sessionId: "exchange-fold",
      sequence: windowStart + offset + 1,
      type: draft.type,
      payload: draft.payload,
      turnId: draft.turnId,
      occurredAt: new Date(epoch.current - (last - draft.at) * 1000).toISOString(),
    }));
  }, [drafts, count, windowStart]);
  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col px-4 py-4 sm:px-8">
      <header className="flex flex-wrap items-center gap-2 border-b border-og-border pb-3">
        <span className="mr-2 text-og-sm font-medium">Readable turns</span>
        {(scenarioName === "delegated" ? STAGES : []).map((stage, index) => (
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
            setWindowStart(0);
            setCount(1);
            setPlaying(true);
          }}
        >
          Play
        </button>
        <span className="ml-auto flex gap-2">
          <button className={BUTTON} aria-pressed={!compact} onClick={() => setCompact(!compact)}>
            {compact ? "Readable" : "Classic"}
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
          hasOlder={windowStart > 0}
          hasNewer={historyMode && count < drafts.length}
          onJumpToLatestQuestion={async () => {
            const end = historyMode ? drafts.length : count;
            const target =
              drafts
                .slice(0, end)
                .flatMap((draft, index) => (draft.type === "user.message" ? [index] : []))
                .at(-1) ?? -1;
            if (target < 0) return null;
            setWindowStart(Math.max(0, target - 2));
            setCount(end);
            return target + 1;
          }}
          onLoadOlder={() => {
            olderRequested.current = true;
            if (!deferOlder.current) setWindowStart(0);
          }}
          onOpenSession={() => undefined}
        />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
