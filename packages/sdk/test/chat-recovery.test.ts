import { expect, test } from "bun:test";
import { createChatHandler } from "../src/chat";
import { fakeServer } from "./chat-helpers";
import { ChatPendingFold } from "../src/chat/fold";
import type { SessionEvent } from "../src/types";

test("history reload must expose the outstanding approval", async () => {
  const server = fakeServer({
    reply: () => [
      {
        type: "session.requiresAction",
        payload: {
          approvals: [{ rawItem: { callId: "approval-1", name: "shell" } }],
        },
      },
    ],
  });
  const handler = createChatHandler(server.og, {
    resolve: () => ({ tenant: "acme", user: "alice", conversation: "one" }),
  });
  const post = await handler(
    new Request("https://host.test/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    }),
  );
  expect(await post.text()).toContain("approval-1");
  const restored = await handler(new Request("https://host.test/chat"));
  expect(await restored.text()).toContain("approval-1");
});

test("GET restores all unresolved requests and does not resurrect decided approvals", async () => {
  const server = fakeServer({
    reply: () => [
      {
        type: "session.requiresAction",
        payload: {
          approvals: [
            { rawItem: { callId: "a1", name: "shell" } },
            { rawItem: { callId: "a2", name: "shell" } },
          ],
        },
      },
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: "q1",
            questions: [{ id: "q", kind: "text", prompt: "Name?" }],
            allowSkip: false,
          },
        },
      },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
    continuation: () => [
      {
        type: "session.requiresAction",
        payload: {
          approvals: [{ rawItem: { callId: "a2", name: "shell" } }],
        },
      },
    ],
  });
  const handler = createChatHandler(server.og, {
    resolve: () => ({ tenant: "acme", user: "alice", conversation: "one" }),
  });
  const post = await handler(
    new Request("https://host.test/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    }),
  );
  await post.text();
  const snapshot = await (await handler(new Request("https://host.test/chat"))).json();
  expect(snapshot.status).toBe("requires_action");
  expect(snapshot.pending.map((p: { requestId: string }) => p.requestId)).toEqual([
    "a1",
    "a2",
    "q1",
  ]);
  const response = await handler(
    new Request("https://host.test/chat/respond", {
      method: "POST",
      body: JSON.stringify({ requestId: "a1", decision: "approve" }),
    }),
  );
  await response.text();
  const reopened = await (await handler(new Request("https://host.test/chat"))).json();
  expect(reopened.pending.map((p: { requestId: string }) => p.requestId).sort()).toEqual([
    "a2",
    "q1",
  ]);
});

test("pending replay honors decisions, expiry, and the owning turn's terminal events", () => {
  const fold = new ChatPendingFold();
  const push = (type: SessionEvent["type"], payload: unknown, turnId = "active") =>
    fold.push({ type, payload, turnId } as SessionEvent);
  push("session.humanInput.requested", {
    request: { id: "expired", questions: [], expiresAt: "2000-01-01T00:00:00Z" },
  });
  push("session.humanInput.requested", { request: { id: "pending", questions: [] } });
  push("session.humanInput.requested", { request: { id: "answered", questions: [] } });
  push("user.humanInputResponse", { requestId: "answered" });
  push("session.requiresAction", { approvals: [{ id: "approval" }] });
  push("turn.cancelled", {}, "queued");
  expect(fold.pending().map((p) => p.requestId)).toEqual(["pending", "approval"]);
  push("user.approvalDecision", { approvalId: "approval" });
  expect(fold.pending().map((p) => p.requestId)).toEqual(["pending"]);
  push("turn.completed", {});
  expect(fold.pending()).toEqual([]);
});

test("respond restores another pending question when the worker only re-emits waiting status", async () => {
  const server = fakeServer({
    reply: () => [
      ...["q1", "q2"].map((id) => ({
        type: "session.humanInput.requested" as const,
        payload: { request: { id, questions: [{ id: "q", kind: "text", prompt: "Name?" }] } },
      })),
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
    continuation: ({ payload }) =>
      payload.requestId === "q1"
        ? [{ type: "session.status.changed", payload: { status: "requires_action" } }]
        : [{ type: "turn.completed" }],
  });
  const original = await server.og.chat({ tenant: "acme", user: "alice", conversation: "one" });
  expect((await original.send("hello")).pending?.requestId).toBe("q1");
  const reopened = await server.og.chat({ tenant: "acme", user: "alice", conversation: "one" });
  expect((await reopened.snapshot()).pending.map((p) => p.requestId)).toEqual(["q1", "q2"]);
  expect(
    (await reopened.respond({ requestId: "q1", answers: [{ questionId: "q", values: ["Alice"] }] }))
      .pending?.requestId,
  ).toBe("q2");
  expect(
    (await reopened.respond({ requestId: "q2", answers: [{ questionId: "q", values: ["Bob"] }] }))
      .status,
  ).toBe("completed");
  expect((await reopened.snapshot()).pending).toEqual([]);
});
