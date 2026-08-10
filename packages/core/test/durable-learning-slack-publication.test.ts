import { describe, expect, test } from "bun:test";
import {
  durableLearningImportance,
  durableLearningSlackProjection,
  publishDurableLearningOutcomeToSlack,
  type DurableLearningSlackOutcome,
} from "../src";

function outcome(
  overrides: Partial<DurableLearningSlackOutcome["receipt"]> = {},
): DurableLearningSlackOutcome {
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const inputHash = "a".repeat(64);
  return {
    attempt: {
      id: attemptId,
      accountId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      inputHash,
      actor: { kind: "agent", subjectId: "agent-1" },
      initiatingHumanSubjectId: "human-1",
      sessionId: "44444444-4444-4444-8444-444444444444",
      request: {
        operation: "write",
        subject: { kind: "decision", summary: "Adopt the governed delivery adapter." },
        evidence: [{ kind: "human_statement" }],
      },
    },
    receipt: {
      attemptId,
      inputHash,
      outcome: "applied",
      decision: {
        code: "ROUTED",
        destination: "memory",
        scope: { kind: "workspace" },
        authority: "active",
      },
      resource: { surface: "memory", id: "memory-1", version: "1", status: "active" },
      createdAt: "2026-08-10T05:30:00.000Z",
      ...overrides,
    },
  };
}

describe("governed-learning Slack adapter", () => {
  test("classifies durable decision and terminal outcomes without reading raw content", () => {
    expect(durableLearningImportance(outcome())).toBe("major");
    expect(durableLearningImportance(outcome({ outcome: "failed" }))).toBe("major");
    expect(durableLearningImportance(outcome({ outcome: "noop" }))).toBe("minor");
  });

  test("omits credential-shaped summary and destination from the persisted projection", () => {
    const syntheticCredential = `github_pat_${"B".repeat(32)}`;
    const input = outcome();
    if (input.attempt.request.operation !== "write") throw new Error("expected write fixture");
    input.attempt.request.subject.summary = `Adopt api_key=${syntheticCredential} for the rollout.`;
    input.receipt.decision.destination = `workspace_memory?token=${syntheticCredential}`;

    const projection = durableLearningSlackProjection(input);
    expect(projection).not.toBeNull();
    expect(input.attempt.request.subject.summary).toContain(syntheticCredential);
    expect(input.receipt.decision.destination).toContain(syntheticCredential);
    expect(JSON.stringify(projection)).not.toContain(syntheticCredential);
    expect(projection?.summary).toContain("[credential omitted]");
    expect(projection?.destination).toContain("[credential omitted]");
  });

  test("omits credential-shaped rollback destinations from both projection fields", () => {
    const syntheticCredential = `xoxb-${"C".repeat(32)}`;
    const input = outcome();
    input.attempt.request = {
      operation: "rollback",
      targetAttemptId: "55555555-5555-4555-8555-555555555555",
    };
    input.receipt.decision.destination = `governed knowledge ${syntheticCredential}`;

    const projection = durableLearningSlackProjection(input);
    expect(JSON.stringify(projection)).not.toContain(syntheticCredential);
    expect(projection?.summary).toContain("[credential omitted]");
    expect(projection?.destination).toContain("[credential omitted]");
  });

  test("fails before storage for mismatched, non-workspace, or connector-derived outcomes", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("adapter touched storage before its contract fence");
        },
      },
    ) as Parameters<typeof publishDurableLearningOutcomeToSlack>[0];
    const mismatch = outcome({ inputHash: "b".repeat(64) });
    expect(await publishDurableLearningOutcomeToSlack(db, mismatch)).toEqual({
      kind: "contract_mismatch",
      enqueue: null,
    });
    const personal = outcome();
    personal.receipt.decision.scope = { kind: "user" };
    expect(await publishDurableLearningOutcomeToSlack(db, personal)).toEqual({
      kind: "not_workspace_scoped",
      enqueue: null,
    });
    const connector = outcome();
    if (connector.attempt.request.operation === "write") {
      connector.attempt.request.evidence = [{ kind: "connector" }];
    }
    expect(await publishDurableLearningOutcomeToSlack(db, connector)).toEqual({
      kind: "connector_evidence_untrusted",
      enqueue: null,
    });
  });
});
