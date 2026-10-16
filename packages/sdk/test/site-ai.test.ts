import { expect, test } from "bun:test";
import { createOpenGeniSiteAi } from "../src/site-ai";
import type { CreateSessionRequest, SessionEvent } from "../src/types";

function fixture(
  events: Array<Partial<SessionEvent>>,
  onCreate?: (input: CreateSessionRequest) => void,
) {
  const requests: CreateSessionRequest[] = [];
  const ai = createOpenGeniSiteAi(
    {
      async createSession(_workspace, input) {
        requests.push(input);
        onCreate?.(input);
        return { id: "session" } as Awaited<
          ReturnType<import("../src/client").OpenGeniClient["createSession"]>
        >;
      },
      async *streamEvents() {
        for (const [index, event] of events.entries())
          yield { sequence: index + 1, payload: {}, turnId: "turn", ...event } as SessionEvent;
      },
    },
    "site-host",
  );
  return { ai, requests };
}

test("inline input is unchanged and uses native create and event folding without UI", async () => {
  const { ai, requests } = fixture([
    { type: "agent.message.delta", payload: { text: '{"choice":', messageId: "a" } },
    { type: "agent.message.completed", payload: { text: '{"choice":2}', messageId: "a" } },
    { type: "turn.completed" },
  ]);
  const chunks: string[] = [];
  let handle: string | null = null;
  const input = JSON.stringify({ prompt: "Choose a route", context: { paths: ["a", "b"] } });
  const result = await ai.run(
    { initialMessage: input, idempotencyKey: "app-action-1" },
    {
      onSession: (id) => {
        handle = id;
      },
      onText: (text) => chunks.push(text),
    },
  );
  expect(requests).toEqual([{ initialMessage: input, idempotencyKey: "app-action-1" }]);
  expect(result).toEqual({
    sessionId: "session",
    turnId: "turn",
    text: '{"choice":2}',
    status: "completed",
    after: 3,
  });
  expect(chunks.join("")).toBe(result.text);
  expect(handle as string | null).toBe("session");
});

test("result replays without another create and ignores another turn's settlement", async () => {
  const { ai, requests } = fixture([
    { type: "turn.completed", turnId: "older" },
    { type: "agent.message.completed", payload: { text: "Answer" } },
    { type: "turn.completed" },
  ]);
  expect(await ai.result("session", { turnId: "turn" })).toMatchObject({
    text: "Answer",
    after: 3,
  });
  expect(requests).toHaveLength(0);
});

test("redacted host approval waits are pending, never successful output", async () => {
  for (const type of ["session.requiresAction", "session.humanInput.requested"]) {
    const { ai } = fixture([{ type, payload: {} }]);
    expect(await ai.run({ initialMessage: "App-designed task" })).toMatchObject({
      status: "pending",
    });
  }
});

test("failures stay failures; cancellation and aborted observation are distinct", async () => {
  const failed = fixture([{ type: "turn.failed", payload: { code: "site_budget_exhausted" } }]);
  await expect(failed.ai.result("session")).rejects.toMatchObject({
    code: "site_budget_exhausted",
  });
  expect(await fixture([{ type: "turn.cancelled" }]).ai.result("session")).toMatchObject({
    status: "cancelled",
  });
  const stopped = fixture([]);
  await expect(
    stopped.ai.run({ initialMessage: "Never send" }, { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(stopped.requests).toHaveLength(0);
});

test("inline helper does not forward runtime authority or invent prompts", async () => {
  const { ai, requests } = fixture([{ type: "turn.completed" }]);
  await ai.run({
    initialMessage: "x",
    model: "viewer-model",
    tools: [{ id: "private" }],
  } as Parameters<typeof ai.run>[0]);
  expect(requests[0]).toMatchObject({ initialMessage: "x", model: "viewer-model" });
  expect(requests[0]).not.toHaveProperty("tools");
});

test("resume forwards the native covered cursor and returns subsequent text only", async () => {
  const requests: unknown[] = [];
  const ai = createOpenGeniSiteAi(
    {
      createSession: async () => {
        throw new Error("must not create");
      },
      async *streamEvents(workspace, sessionId, options) {
        requests.push({ workspace, sessionId, options });
        yield {
          sequence: 8,
          coveredThrough: 12,
          turnId: "turn",
          type: "session.event.envelope_omitted",
          payload: {},
        } as SessionEvent;
        yield {
          sequence: 13,
          turnId: "turn",
          type: "agent.message.delta",
          payload: { text: "later", messageId: "answer" },
        } as SessionEvent;
        yield {
          sequence: 14,
          coveredThrough: 18,
          turnId: "turn",
          type: "turn.completed",
          payload: {},
        } as SessionEvent;
      },
    },
    "site-host",
  );
  expect(await ai.result("retained", { after: 7, turnId: "turn" })).toEqual({
    sessionId: "retained",
    turnId: "turn",
    text: "later",
    status: "completed",
    after: 18,
  });
  expect(requests).toEqual([
    { workspace: "site-host", sessionId: "retained", options: { after: 7 } },
  ]);
  await expect(fixture([]).ai.result("retained")).rejects.toThrow("ended before the turn settled");
});
