import type { SessionEvent } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   The playground's recorded conversation: what Acme's support agent does for
   each suggested question, as the session events the real timeline renders
   (`@opengeni/react` MessageTimeline). Every event type and payload follows
   `packages/react/src/timeline/projection.ts`, the same shapes the server
   emits, so the demo is the product's own UI with no model behind it.
   -------------------------------------------------------------------------- */

export type ScriptBeat =
  | { kind: "think"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      display?: { title: string; accountLabel?: string };
      args: unknown;
      output: unknown;
      /** How long the call runs before its result shows. */
      ms: number;
    }
  | { kind: "say"; text: string };

export type ExchangeId = "order" | "charged" | "remember" | "recall" | "refund";

export type ScriptedExchange = Readonly<{
  id: ExchangeId;
  question: string;
  /** Asked in a new chat (recall shows memory carries across chats). */
  freshChat?: boolean;
  beats: readonly ScriptBeat[];
}>;

export const ACME_EXCHANGES: Record<ExchangeId, ScriptedExchange> = {
  order: {
    id: "order",
    question: "Where is my order #4417?",
    beats: [
      {
        kind: "say",
        text: "Your order **#4417** shipped yesterday with UPS and is out for delivery. It should arrive **today by 6 pm**, and the tracking link is in your confirmation email.",
      },
    ],
  },
  charged: {
    id: "charged",
    question: "I was charged twice this month",
    beats: [
      {
        kind: "say",
        text: "Sorry about that. I can see two charges of **$49** on March 3, three seconds apart. The second one was an automatic retry, so it's a duplicate. Want me to refund it?",
      },
    ],
  },
  remember: {
    id: "remember",
    question: "Remember that my plan is Pro.",
    beats: [
      {
        kind: "tool",
        id: "call-remember",
        name: "knowledge_save",
        args: {
          entry: { kind: "note", title: "Plan: Pro", content: "This customer is on the Pro plan." },
        },
        output: { entryId: "kn_pro_plan", version: 1, outcome: "published" },
        ms: 700,
      },
      { kind: "say", text: "Got it. I'll remember that you're on the **Pro** plan." },
    ],
  },
  recall: {
    id: "recall",
    question: "What plan did I tell you I'm on?",
    freshChat: true,
    beats: [
      {
        kind: "tool",
        id: "call-recall",
        name: "knowledge_search",
        args: { query: "customer plan" },
        output: [{ title: "Plan: Pro", snippet: "This customer is on the Pro plan." }],
        ms: 800,
      },
      {
        kind: "say",
        text: "You told me you're on the **Pro** plan. That includes priority support and free returns.",
      },
    ],
  },
  refund: {
    id: "refund",
    question: "I was charged twice. Can you refund the extra one?",
    beats: [
      {
        kind: "think",
        text: "Find the second $49 charge on the March invoice, then refund only that one.",
      },
      {
        kind: "tool",
        id: "call-charges",
        name: "billing__list_charges",
        display: { title: "Look up charges", accountLabel: "Acme billing" },
        args: { period: "March" },
        output: {
          charges: [
            { id: "ch_3Pq81", amount: 49, created: "Mar 3, 09:12:04" },
            { id: "ch_3Pq84", amount: 49, created: "Mar 3, 09:12:07", note: "automatic retry" },
          ],
        },
        ms: 900,
      },
      {
        kind: "tool",
        id: "call-refund",
        name: "billing__refund_charge",
        display: { title: "Refund charge", accountLabel: "Acme billing" },
        args: { charge: "ch_3Pq84", amount: 49 },
        output: { refunded: true, amount: 49, arrives: "in 5-10 business days" },
        ms: 800,
      },
      {
        kind: "say",
        text: "Done. I refunded the duplicate **$49** charge. It will be back on your card in 5-10 business days.",
      },
    ],
  },
};

/** A timed session event, relative to when the visitor asked. */
export type TimedEvent = Readonly<{
  afterMs: number;
  type: SessionEvent["type"];
  payload: unknown;
  turnId: string | null;
}>;

/** How fast the recording plays: close to a real quick model. */
export const SCRIPT_TIMING = { queueMs: 150, startMs: 450, wordMs: 38, beatGapMs: 260 } as const;

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
 * The events one exchange produces, each with its delay from the question:
 * the message, the turn starting, any thinking and tool calls, the answer
 * streamed word by word, and the turn completing.
 */
export function exchangeTimeline(exchange: ScriptedExchange, turnId: string): TimedEvent[] {
  const out: TimedEvent[] = [
    { afterMs: 0, type: "user.message", payload: { text: exchange.question }, turnId: null },
    {
      afterMs: SCRIPT_TIMING.queueMs,
      type: "turn.queued",
      payload: { turnId, source: "user", routing: "accepted_for_execution" },
      turnId,
    },
    { afterMs: SCRIPT_TIMING.startMs, type: "turn.started", payload: { turnId }, turnId },
  ];
  let at = SCRIPT_TIMING.startMs + SCRIPT_TIMING.beatGapMs;
  for (const beat of exchange.beats) {
    if (beat.kind === "think") {
      for (const word of words(beat.text)) {
        out.push({ afterMs: at, type: "agent.reasoning.delta", payload: { text: word }, turnId });
        at += SCRIPT_TIMING.wordMs / 2;
      }
    } else if (beat.kind === "tool") {
      out.push({
        afterMs: at,
        type: "agent.toolCall.created",
        payload: {
          id: beat.id,
          name: beat.name,
          arguments: beat.args,
          ...(beat.display ? { display: { toolName: beat.name, ...beat.display } } : {}),
        },
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
        payload: { text: beat.text },
        turnId,
      });
    }
    at += SCRIPT_TIMING.beatGapMs;
  }
  out.push({ afterMs: at, type: "turn.completed", payload: {}, turnId });
  return out;
}

/** The questions to offer outside the tour: everything not yet asked, recall after remember. */
export function suggestedQuestions(asked: readonly ExchangeId[]): ExchangeId[] {
  return (["order", "charged", "refund", "remember", "recall"] as const).filter(
    (id) => !asked.includes(id) && (id !== "recall" || asked.includes("remember")),
  );
}
