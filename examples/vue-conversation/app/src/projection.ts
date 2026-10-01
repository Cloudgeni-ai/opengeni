import type { SessionApprovalRequest, SessionEvent } from "@opengeni/sdk";

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  turnId?: string | null;
};
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Small text-only projection, not a substitute for the full React timeline. */
export function project(events: SessionEvent[]) {
  const messages: Message[] = [];
  const identified = new Map<string, Message>();
  let approvals: SessionApprovalRequest[] = [];
  let approvalTurn: string | null | undefined;
  let failure: string | null = null;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const p = object(event.payload);
    if (event.type === "user.message" && typeof p.text === "string") {
      messages.push({ id: event.id, role: "user", text: p.text, turnId: event.turnId });
    } else if (event.type === "agent.message.delta" || event.type === "agent.message.completed") {
      if (typeof p.text !== "string") continue;
      const key = JSON.stringify([event.turnId, p.messageId ?? "legacy"]);
      let message = identified.get(key);
      if (
        !message ||
        (p.messageId == null && !message.streaming && event.type === "agent.message.delta")
      ) {
        message = {
          id: event.id,
          role: "assistant",
          text: "",
          turnId: event.turnId,
          streaming: true,
        };
        messages.push(message);
        identified.set(key, message);
      }
      if (event.type === "agent.message.completed") {
        message.text = p.text || message.text;
        message.streaming = false;
      } else if (message.streaming) message.text += p.text;
    } else if (event.type === "turn.completed" && typeof p.output === "string" && p.output.trim()) {
      const latest = messages.findLast((m) => m.role === "assistant" && m.turnId === event.turnId);
      if (latest?.streaming) {
        latest.text = p.output;
        latest.streaming = false;
      } else if (latest?.text !== p.output)
        messages.push({ id: event.id, role: "assistant", text: p.output, turnId: event.turnId });
    }
    if (event.type === "session.requiresAction") {
      approvals = Array.isArray(p.approvals)
        ? p.approvals.filter((a): a is SessionApprovalRequest => {
            const value = object(a);
            return typeof value.id === "string" && typeof value.name === "string";
          })
        : [];
      approvalTurn = event.turnId;
    }
    if (event.type === "user.approvalDecision")
      approvals = approvals.filter((a) => a.id !== p.approvalId);
    if (
      ["turn.completed", "turn.failed", "turn.cancelled", "turn.superseded"].includes(event.type)
    ) {
      if (approvalTurn == null || event.turnId == null || event.turnId === approvalTurn)
        approvals = [];
      for (const message of messages)
        if (message.turnId === event.turnId) message.streaming = false;
    }
    if (event.type === "turn.started") failure = null;
    if (event.type === "turn.failed")
      failure =
        "The assistant could not finish. Your conversation is saved; refresh to check its status.";
    // Unknown additive event types remain in the log but do not become prose.
  }
  return { messages, approvals, failure };
}
