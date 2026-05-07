import { describe, expect, test } from "bun:test";
import { ClientConfig, ClientSessionEvent, CreateSessionRequest, SessionBusMessage } from "../src";

describe("contracts", () => {
  test("accepts create session defaults", () => {
    const payload = CreateSessionRequest.parse({ initialMessage: "inspect repo" });
    expect(payload.resources).toEqual([]);
    expect(payload.metadata).toEqual({});
  });

  test("accepts model and reasoning effort on create session", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    expect(payload.model).toBe("gpt-5.5");
    expect(payload.reasoningEffort).toBe("xhigh");
  });

  test("accepts client config payloads", () => {
    const payload = ClientConfig.parse({
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5"],
      defaultReasoningEffort: "high",
      allowedReasoningEfforts: ["low", "medium", "high"],
    });
    expect(payload.defaultReasoningEffort).toBe("high");
  });

  test("rejects empty user message command", () => {
    expect(() => ClientSessionEvent.parse({
      type: "user.message",
      payload: { text: "" },
    })).toThrow();
  });

  test("accepts full realtime bus messages", () => {
    const message = SessionBusMessage.parse({
      sessionId: "00000000-0000-4000-8000-000000000001",
      events: [{
        id: "00000000-0000-4000-8000-000000000002",
        sessionId: "00000000-0000-4000-8000-000000000001",
        sequence: 1,
        type: "agent.message.delta",
        payload: { text: "hi" },
        occurredAt: new Date().toISOString(),
      }],
    });
    expect(message.events[0]?.type).toBe("agent.message.delta");
  });
});
