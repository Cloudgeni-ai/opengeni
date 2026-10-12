import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  buildTimeline,
  MessageSenderLabel,
  MessageTimeline,
  type RenderMessageSender,
  type UserMessageItem,
} from "../src";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

function message(sequence: number, initiator: unknown): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type: "user.message",
    payload: { text: `message ${sequence}`, ...(initiator ? { initiator } : {}) },
    occurredAt: new Date(1_750_000_000_000 + sequence * 1000).toISOString(),
    clientEventId: null,
  } as SessionEvent;
}

const events = [
  message(1, { kind: "subject", subjectId: "user:me", label: "me@example.test" }),
  message(2, { kind: "subject", subjectId: "user:kari", label: "kari@example.test" }),
  message(3, { kind: "agent", sessionId: "session-0" }),
  message(4, null),
];

describe("who sent a message", () => {
  test("a person's message carries the sender frozen with it; others carry none", () => {
    const senders = buildTimeline(events)
      .filter((item): item is UserMessageItem => item.kind === "user-message")
      .map((item) => item.sender ?? null);
    expect(senders).toEqual([
      { subjectId: "user:me", label: "me@example.test" },
      { subjectId: "user:kari", label: "kari@example.test" },
      null,
      null,
    ]);
  });

  test("the host names other people's messages and leaves its own viewer's unlabeled", async () => {
    const seen: string[] = [];
    const renderSender: RenderMessageSender = (sender) => {
      seen.push(sender.subjectId);
      return sender.subjectId === "user:me" ? null : (
        <MessageSenderLabel name={sender.label ?? sender.subjectId} />
      );
    };
    const view = await renderComponent(
      <MessageTimeline events={events} renderMessageSender={renderSender} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("kari@example.test");
    expect(text).not.toContain("me@example.test");
    expect(seen.sort()).toEqual(["user:kari", "user:me"]);
    await view.unmount();
  });

  test("without a renderer no sender is shown", async () => {
    const view = await renderComponent(<MessageTimeline events={events} />);
    expect(view.container.textContent ?? "").not.toContain("kari@example.test");
    await view.unmount();
  });
});
