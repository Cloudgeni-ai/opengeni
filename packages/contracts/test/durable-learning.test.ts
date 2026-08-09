import { describe, expect, test } from "bun:test";
import { DURABLE_LEARNING_CONTRACT_VERSION, DurableLearningRequest } from "../src/durable-learning";

describe("durable learning contract", () => {
  test("accepts an explicit workspace memory write", () => {
    const parsed = DurableLearningRequest.parse({
      contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
      operation: "write",
      attemptId: "10000000-0000-4000-8000-000000000001",
      origin: "explicit_remember",
      requestedAuthority: "active",
      requestedScope: { kind: "workspace" },
      targetSurface: "memory",
      subject: {
        kind: "decision",
        content: "Use one canonical durable-learning router.",
      },
      evidence: [
        {
          kind: "human_statement",
          sourceId: "session-message-42",
          eligibility: "eligible",
        },
      ],
    });

    expect(parsed.operation).toBe("write");
    if (parsed.operation !== "write") throw new Error("expected a write request");
    expect(parsed.subject.stableKey).toBeNull();
    expect(parsed.evidence[0]?.sourceVersion).toBeNull();
  });

  test("keeps rollback as a separate immutable attempt", () => {
    const parsed = DurableLearningRequest.parse({
      contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
      operation: "rollback",
      attemptId: "10000000-0000-4000-8000-000000000002",
      origin: "explicit_remember",
      targetAttemptId: "10000000-0000-4000-8000-000000000001",
      reason: "The recorded decision was incorrect.",
    });

    expect(parsed.operation).toBe("rollback");
    if (parsed.operation !== "rollback") throw new Error("expected a rollback request");
    expect(parsed.targetAttemptId).not.toBe(parsed.attemptId);
  });
});
