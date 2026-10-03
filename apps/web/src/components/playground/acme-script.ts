import type { SessionEvent } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   The playground's recorded conversation: what Acme's support agent does for
   each question, given the agent settings the visitor picked. Replies are the
   session events the real `@opengeni/react` components render (every type and
   payload follows `packages/react/src/timeline/projection.ts`), so the demo is
   the product's own UI with no model behind it.
   -------------------------------------------------------------------------- */

/** The agent settings the playground offers; each maps to one line of server code. */
export type AgentSettings = Readonly<{
  /** Acme's own actions as MCP tools (`mcpServers`). */
  tools: boolean;
  /** Remembers each customer across chats (the `knowledge` capability). */
  memory: boolean;
  /** Thinks before answering (`reasoningEffort: "high"`). */
  thinking: boolean;
}>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  tools: false,
  memory: false,
  thinking: false,
};

export type ScriptBeat =
  | { kind: "think"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      output: unknown;
      /** How long the call runs before its result shows. */
      ms: number;
    }
  | { kind: "say"; text: string };

export type QuestionId = "order" | "charged" | "refund" | "other";

export const QUESTIONS: Record<Exclude<QuestionId, "other">, string> = {
  order: "Where is my order #4417?",
  charged: "Was I charged twice this month?",
  refund: "Yes, refund the extra one",
};

/** A short chat title, as the agent would set it. */
export const QUESTION_TITLES: Record<QuestionId, string> = {
  order: "Order #4417",
  charged: "Double charge",
  refund: "Refund",
  other: "Question",
};

/** Which recorded answer a typed message gets. */
export function matchQuestion(text: string): QuestionId {
  const normalized = text.toLowerCase();
  if (/\brefund|\byes\b/u.test(normalized)) return "refund";
  if (/charg|bill|invoice|pay|twice|double/u.test(normalized)) return "charged";
  if (/order|deliver|ship|track|package|parcel|#?\d{3,}/u.test(normalized)) return "order";
  return "other";
}

const MEMORY_SEARCH: ScriptBeat = {
  kind: "tool",
  id: "call-memory",
  name: "knowledge_search",
  args: { query: "this customer's preferences" },
  output: [
    { title: "Plan", snippet: "Pro plan since 2024." },
    { title: "Contact", snippet: "Prefers email updates." },
  ],
  ms: 650,
};

function thinkingFor(question: QuestionId, settings: AgentSettings): ScriptBeat[] {
  if (!settings.thinking) return [];
  const text = {
    order: settings.tools
      ? "They want the status of order 4417. Look it up instead of guessing."
      : "They want order 4417's status, but I have no way to look orders up. Say so plainly.",
    charged: settings.tools
      ? "Check this month's charges for a duplicate before answering."
      : "I can't see billing. Explain what I'd need instead of guessing.",
    refund: settings.tools
      ? "Refund only the duplicate, not the original charge."
      : "I can't issue refunds without a billing tool.",
    other: "Answer briefly and point to what I can help with.",
  }[question];
  return [{ kind: "think", text }];
}

/** What the agent adds when it remembers this customer (the memory lookup found Pro). */
const REMEMBERED: Record<QuestionId, string> = {
  order: " You're on Pro, so shipping and returns are free.",
  charged: " You're on Pro, so refunds go out the same day.",
  refund: " You're on Pro, so it goes out today.",
  other: " Welcome back. You're on the Pro plan.",
};

/** The beats of one answer: thinking, a memory lookup, tool calls, then the reply. */
export function replyBeats(question: QuestionId, settings: AgentSettings): ScriptBeat[] {
  const beats: ScriptBeat[] = [...thinkingFor(question, settings)];
  if (settings.memory) beats.push(MEMORY_SEARCH);
  const say = (text: string): ScriptBeat => ({
    kind: "say",
    text: settings.memory ? `${text}${REMEMBERED[question]}` : text,
  });
  switch (question) {
    case "order":
      if (!settings.tools) {
        beats.push(
          say(
            "I can't see orders yet. Once Acme gives me an order lookup, I can check **#4417** for you.",
          ),
        );
        break;
      }
      beats.push(
        {
          kind: "tool",
          id: "call-order",
          name: "acme__get_order",
          args: { orderId: "4417" },
          output: { id: "4417", status: "out_for_delivery", carrier: "UPS", eta: "today, 6 pm" },
          ms: 800,
        },
        say("Order **#4417** is out for delivery with UPS and should arrive **today by 6 pm**."),
      );
      break;
    case "charged":
      if (!settings.tools) {
        beats.push(
          say(
            "I can't see your billing yet. With access to Acme's billing, I could check for a duplicate charge and refund it.",
          ),
        );
        break;
      }
      beats.push(
        {
          kind: "tool",
          id: "call-charges",
          name: "acme__list_charges",
          args: { period: "this month" },
          output: {
            charges: [
              { id: "ch_81", amount: "$49.00", at: "Oct 1, 09:12:04" },
              { id: "ch_84", amount: "$49.00", at: "Oct 1, 09:12:07", note: "payment retry" },
            ],
          },
          ms: 900,
        },
        say(
          "Yes. You were charged **$49** twice on Oct 1, three seconds apart. The second is a duplicate from a payment retry. Want me to refund it?",
        ),
      );
      break;
    case "refund":
      if (!settings.tools) {
        beats.push(
          say("I can't issue refunds yet. Acme would need to give me a refund tool first."),
        );
        break;
      }
      beats.push(
        {
          kind: "tool",
          id: "call-refund",
          name: "acme__refund_charge",
          args: { chargeId: "ch_84" },
          output: { refunded: "$49.00", arrives: "in 5-10 business days" },
          ms: 800,
        },
        say("Done. The duplicate **$49** is on its way back to your card."),
      );
      break;
    default:
      beats.push(
        say(
          "This is a recorded demo, so I can answer a few things: where order **#4417** is, or whether you were charged twice.",
        ),
      );
  }
  return beats;
}

/** A timed session event, relative to when the visitor asked. */
export type TimedEvent = Readonly<{
  afterMs: number;
  type: SessionEvent["type"];
  payload: unknown;
  turnId: string | null;
}>;

/** How fast the recording plays: close to a real quick model. */
export const SCRIPT_TIMING = { queueMs: 150, startMs: 450, wordMs: 45, beatGapMs: 380 } as const;

function words(text: string): string[] {
  return text.match(/\S+\s*/gu) ?? [];
}

function mcpText(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

/**
 * The events one answer produces after the question, each with its delay:
 * the turn starting, thinking and tool calls, the reply streamed word by
 * word, and the turn completing. The question itself is added by the caller.
 */
export function replyTimeline(beats: readonly ScriptBeat[], turnId: string): TimedEvent[] {
  const out: TimedEvent[] = [
    {
      afterMs: SCRIPT_TIMING.queueMs,
      type: "turn.queued",
      payload: { turnId, source: "user", routing: "accepted_for_execution" },
      turnId,
    },
    {
      afterMs: SCRIPT_TIMING.startMs,
      type: "session.status.changed",
      payload: { status: "running" },
      turnId,
    },
    { afterMs: SCRIPT_TIMING.startMs, type: "turn.started", payload: { turnId }, turnId },
  ];
  let at = SCRIPT_TIMING.startMs + SCRIPT_TIMING.beatGapMs;
  for (const beat of beats) {
    if (beat.kind === "think") {
      for (const word of words(beat.text)) {
        out.push({ afterMs: at, type: "agent.reasoning.delta", payload: { text: word }, turnId });
        at += SCRIPT_TIMING.wordMs / 2;
      }
    } else if (beat.kind === "tool") {
      out.push({
        afterMs: at,
        type: "agent.toolCall.created",
        payload: { id: beat.id, name: beat.name, arguments: beat.args },
        turnId,
      });
      at += beat.ms;
      out.push({
        afterMs: at,
        type: "agent.toolCall.output",
        payload: { id: beat.id, output: mcpText(beat.output), error: false },
        turnId,
      });
    } else {
      for (const word of words(beat.text)) {
        out.push({ afterMs: at, type: "agent.message.delta", payload: { text: word }, turnId });
        at += SCRIPT_TIMING.wordMs;
      }
      out.push({
        afterMs: at,
        type: "agent.message.completed",
        payload: { phase: "final", text: beat.text },
        turnId,
      });
    }
    at += SCRIPT_TIMING.beatGapMs;
  }
  out.push({ afterMs: at, type: "turn.completed", payload: {}, turnId });
  out.push({ afterMs: at, type: "session.status.changed", payload: { status: "idle" }, turnId });
  return out;
}
