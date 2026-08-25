import { createRoot } from "react-dom/client";

import { MessageTimeline } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import "./styles.css";

let sequence = 0;
const turnId = "11111111-1111-4111-8111-111111111111";

function event(type: string, payload: unknown): SessionEvent {
  sequence += 1;
  return {
    id: `held-event-${sequence}`,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    sequence,
    type,
    payload,
    occurredAt: new Date(1_777_000_000_000 + sequence * 1_000).toISOString(),
    turnId,
  };
}

const fallback = "The child is still running; I will resume when it finishes.";
const events = [
  event("user.message", { text: "Wait for the child and keep me posted." }),
  event("agent.message.completed", { text: fallback, phase: "commentary" }),
  event("agent.toolCall.created", {
    id: "goal-wait-call",
    name: "goal_wait",
    arguments: { reason: "child still running", untilSeconds: 900 },
  }),
  event("goal.held", { actor: "agent", reason: "child still running" }),
  event("agent.toolCall.output", { id: "goal-wait-call", output: { status: "held" } }),
  event("turn.completed", {}),
];

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 32 }} data-og-theme="light">
    <section data-held-turn-test style={{ margin: "0 auto", maxWidth: 760 }}>
      <MessageTimeline
        className="timeline-held-turn-shell"
        events={events}
        renderMessageText={(text, item) => <div data-held-turn-message={item.id}>{text}</div>}
      />
    </section>
  </main>,
);
