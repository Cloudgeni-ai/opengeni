import { describe, expect, mock, test } from "bun:test";

mock.module("@/context", () => ({
  useAppContext: () => ({ client: { getSessionModelContext: mock(async () => null) } }),
}));

mock.module("sonner", () => ({
  toast: { error: mock(() => undefined), success: mock(() => undefined) },
}));

describe("model context inspector", () => {
  test("reads the latest provider usage event", async () => {
    const { providerUsageFromEvents } = await import("./model-context-inspector");
    expect(
      providerUsageFromEvents([
        {
          id: "a",
          type: "agent.model.usage",
          sequence: 1,
          payload: { inputTokens: 10, cachedTokens: 2, outputTokens: 4 },
        } as never,
        {
          id: "b",
          type: "agent.model.usage",
          sequence: 4,
          payload: { inputTokens: 99, cachedTokens: 50, outputTokens: 7 },
        } as never,
      ]),
    ).toEqual({ inputTokens: 99, cachedTokens: 50, outputTokens: 7 });
  });
});
