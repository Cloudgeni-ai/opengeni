import { expect, test } from "bun:test";
import { createAttemptRequestIdGenerator } from "../src/activities/agent-turn/provider-request-identity";
import { createCoreCodexRequests } from "../src/activities/agent-turn/codex-core-requests";

test("independent workflow attempts do not collide in account-wide request custody", async () => {
  const admitted = new Set<string>();
  const reserve = async (request: { requestId: string; transportAttempt: number }) => {
    const key = JSON.stringify([request.requestId, request.transportAttempt]);
    if (admitted.has(key)) throw new Error("duplicate physical request");
    admitted.add(key);
    return { operationId: crypto.randomUUID() };
  };
  const settle = async () => {};
  // Activity numbers are local to a workflow: both activities can be "1".
  // Their durable attempt IDs are independent, including after recovery.
  const attempts = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const attemptId of attempts) {
    const next = createAttemptRequestIdGenerator(attemptId, "codex");
    const tracker = createCoreCodexRequests({ reserve, settle });
    for (let i = 0; i < 2; i++) {
      const request = { requestId: next(), transportAttempt: 1 };
      await tracker.reserve(request);
      await tracker.observe({ ...request, outcome: "response_received" });
      await tracker.checkpoint();
    }
    expect(tracker.canRecover()).toBe(true);
  }
  expect(admitted.size).toBe(6);

  // Restarting the same attempt must not turn its first request into a new
  // dispatch permit, even after its earlier response was durably settled.
  const repeated = createCoreCodexRequests({ reserve, settle });
  await expect(
    repeated.reserve({
      requestId: createAttemptRequestIdGenerator(attempts[0]!, "codex")(),
      transportAttempt: 1,
    }),
  ).rejects.toThrow("duplicate physical request");
  expect(admitted.size).toBe(6);
});

test("model and title calls stay distinct across providers within an attempt", () => {
  const attemptId = crypto.randomUUID();
  const purposes = ["codex", "codex-title", "xai", "xai-title"] as const;
  const ids = purposes.flatMap((purpose) => {
    const next = createAttemptRequestIdGenerator(attemptId, purpose);
    return [next(), next()];
  });
  expect(new Set(ids).size).toBe(8);
  expect(ids.every((id) => id.startsWith(`${attemptId}:`))).toBe(true);
});
