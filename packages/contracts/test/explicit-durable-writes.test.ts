import { describe, expect, test } from "bun:test";
import {
  EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
  ExplicitDurableWriteBinding,
  ExplicitDurableWriteCommand,
  ExplicitDurableWriteReceipt,
} from "../src/explicit-durable-writes";

describe("explicit durable write contract", () => {
  test("accepts bounded personal, workspace, and company remember commands", () => {
    for (const scope of ["personal", "workspace", "company"] as const) {
      const parsed = ExplicitDurableWriteCommand.parse({
        contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
        operation: "remember",
        scope,
        subject: {
          intent: scope === "company" ? "company_mission" : "decision",
          content: `Remember this for ${scope}.`,
        },
      });
      expect(parsed.operation).toBe("remember");
      if (parsed.operation !== "remember") throw new Error("expected remember command");
      expect(parsed.subject.replacesResourceId).toBeNull();
    }
  });

  test("accepts an unspecified scope only as a clarification-producing command", () => {
    const parsed = ExplicitDurableWriteCommand.parse({
      contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
      operation: "remember",
      scope: "unspecified",
      subject: {
        intent: "fact",
        content: "The requested durable scope was not explicit.",
      },
    });
    expect(parsed.operation).toBe("remember");
    if (parsed.operation !== "remember") throw new Error("expected remember command");
    expect(parsed.scope).toBe("unspecified");
  });

  test("does not expose Documents/RAG evidence intents as explicit remember writes", () => {
    const result = ExplicitDurableWriteCommand.safeParse({
      contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
      operation: "remember",
      scope: "workspace",
      subject: {
        intent: "document",
        content: "Do not turn evidence ingestion into an active knowledge write.",
      },
    });
    expect(result.success).toBe(false);
  });

  test("keeps attempt and source evidence in a trusted host binding", () => {
    const binding = ExplicitDurableWriteBinding.parse({
      attemptId: "10000000-0000-4000-8000-000000000001",
      sessionId: "20000000-0000-4000-8000-000000000001",
      sourceMessage: {
        id: "message-42",
        version: "1",
        contentHash: "a".repeat(64),
      },
    });
    if (binding.sourceMessage === null) throw new Error("expected source message binding");
    expect(binding.sourceMessage.contentHash).toHaveLength(64);
  });

  test("public receipts cannot carry an authority rollback token", () => {
    const receipt = ExplicitDurableWriteReceipt.parse({
      contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
      routerContractVersion: "durable-learning.v1",
      operation: "remember",
      attemptId: "10000000-0000-4000-8000-000000000001",
      inputHash: "b".repeat(64),
      idempotency: "created",
      outcome: "applied",
      decision: {
        disposition: "route",
        code: "ROUTED",
        reasons: ["Routed exactly once."],
        clarificationFields: [],
      },
      saved: {
        summary: "Use the canonical durable-learning router.",
        destination: "memory",
        scope: { kind: "workspace" },
        authority: "active",
        resource: { surface: "memory", id: "memory-1", version: "1", status: "active" },
      },
      effectiveBoundary: "next_accepted_attempt",
      inspect: { surface: "memory", resourceId: "memory-1", version: "1" },
      undo: {
        supported: true,
        targetAttemptId: "10000000-0000-4000-8000-000000000001",
      },
      audit: {
        sourceEvidence: [{ sourceId: "message-42", contentHash: "a".repeat(64) }],
      },
      createdAt: "2026-08-09T16:00:00.000Z",
      rollbackToken: "must-not-be-projected",
    });

    expect("rollbackToken" in receipt).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("must-not-be-projected");
  });
});
