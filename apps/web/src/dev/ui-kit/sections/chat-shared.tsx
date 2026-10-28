import type { ReactNode } from "react";
import { MessageTimeline } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Shared helpers for the chat decision sections: fixture events and a chat
   frame that renders the real timeline with a pending surface at its end, the
   way the console and the embedded chat place approvals and questions.
   -------------------------------------------------------------------------- */

/**
 * `&part=<name>` renders only that part of a chat section, so screenshots of
 * one block fit a single viewport. Without it every part renders.
 */
export function showPart(name: string): boolean {
  if (typeof window === "undefined") return true;
  const part = new URLSearchParams(window.location.search).get("part");
  return part === null || part === name;
}

let sequence = 0;

/** One fixture event; each call gets the next sequence. */
export function kitEvent(type: string, payload: unknown, turnId = "turn-kit"): SessionEvent {
  sequence += 1;
  return {
    id: `kit-chat-${sequence}`,
    workspaceId: "ws-kit",
    sessionId: "session-kit",
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 8, 26, 11, 40, sequence % 60)).toISOString(),
    turnId,
  } as SessionEvent;
}

/** A short exchange that leads up to a pending decision. */
export function lead(userText: string, agentText: string): SessionEvent[] {
  return [
    kitEvent("user.message", { text: userText }),
    kitEvent("agent.message.completed", { text: agentText }),
  ];
}

/**
 * The chat column as people see it: the real timeline, then the pending
 * surface as its trailing state. `height` keeps the bottom-anchored layout.
 */
export function ChatFrame({
  events,
  children,
  height = 560,
  status = "requires_action",
}: {
  events: SessionEvent[];
  children?: ReactNode;
  height?: number;
  status?: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-border bg-bg"
      style={{ height }}
    >
      <div className="min-h-0 flex-1">
        <MessageTimeline
          className="h-full"
          events={events}
          status={status as never}
          trailingState={children}
        />
      </div>
    </div>
  );
}
