import { describe, expect, test } from "bun:test";
import {
  isDeferredAgentMessage,
  SessionSystemUpdatePayload,
  sessionSystemUpdateWakeClass,
} from "../src/index";

describe("agent message wake class", () => {
  const operationId = crypto.randomUUID();

  test("only an Agent message marked deferred overrides its kind's class", () => {
    const deferred = { kind: "agent_message", payload: { wake: "deferred" } };
    expect(isDeferredAgentMessage(deferred)).toBe(true);
    expect(sessionSystemUpdateWakeClass(deferred)).toBe("deferred");
    expect(sessionSystemUpdateWakeClass({ kind: "agent_message", payload: {} })).toBe("immediate");
    expect(sessionSystemUpdateWakeClass({ kind: "agent_message" })).toBe("immediate");
    expect(
      sessionSystemUpdateWakeClass({ kind: "agent_message", payload: { wake: "immediate" } }),
    ).toBe("immediate");
    // The marker means nothing on any other kind.
    expect(
      sessionSystemUpdateWakeClass({
        kind: "child_terminal_result",
        payload: { wake: "deferred" },
      }),
    ).toBe("immediate");
    expect(sessionSystemUpdateWakeClass({ kind: "child_progress" })).toBe("deferred");
  });

  test("the payload contract admits only the deferred marker", () => {
    const base = { type: "agent_message", text: "FYI", operationId };
    expect(SessionSystemUpdatePayload.parse(base)).not.toHaveProperty("wake");
    expect(SessionSystemUpdatePayload.parse({ ...base, wake: "deferred" })).toMatchObject({
      wake: "deferred",
    });
    expect(() => SessionSystemUpdatePayload.parse({ ...base, wake: "later" })).toThrow();
  });
});
