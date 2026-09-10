import type { SessionEvent, SessionSystemUpdateKind } from "@opengeni/sdk";
import { GALLERY_SESSION_ID, GALLERY_WORKSPACE_ID } from "./composer-chrome-fixtures";

/** Same durable event shapes as a live session; no model calls or historical imports. */
export function activityEvents(): SessionEvent[] {
  const events: SessionEvent[] = [];
  const push = (type: string, payload: unknown, turnId = "activity-turn") =>
    events.push({
      id: `activity-event-${events.length}`,
      workspaceId: GALLERY_WORKSPACE_ID,
      sessionId: GALLERY_SESSION_ID,
      sequence: events.length + 1,
      type,
      payload,
      turnId,
      occurredAt: new Date(
        Date.parse("2026-09-05T10:00:00Z") + events.length * 10_000,
      ).toISOString(),
    });
  const member = (kind: SessionSystemUpdateKind, summary: string, classification = "info") => ({
    id: `input-${events.length}-${kind}`,
    kind,
    summary,
    classification,
    sourceId: "33333333-3333-4333-8333-333333333333",
  });
  const tool = (id: string) => {
    push("agent.toolCall.created", {
      id,
      name: "exec_command",
      arguments: { cmd: "bun run check" },
    });
    push("agent.toolCall.output", { id, output: "Checks passed." });
  };
  push("system.update.delivered", {
    members: [
      member("background_command_result", "bun run build: completed successfully.", "success"),
    ],
  });
  tool("check-before");
  push("system.update.delivered", {
    members: [
      member(
        "background_command_result",
        "bun test: result unavailable. Its exit status could not be confirmed.",
      ),
      member("agent_message", "The keyboard review is complete."),
    ],
  });
  tool("check-after");
  push("agent.message.completed", {
    id: "activity-reply",
    text: "The build passed. I also received the review while checking the layout.",
  });
  push("turn.completed", {});
  push(
    "system.update.delivered",
    { members: [member("session_wait_timeout", "The requested wait ended.")] },
    "wait-turn",
  );
  push(
    "agent.message.completed",
    { id: "wait-reply", text: "The wait ended; I’m checking for the remaining result." },
    "wait-turn",
  );
  push("turn.completed", {}, "wait-turn");
  return events;
}
