import { describe, expect, test } from "bun:test";
import type {
  GovernedLearningActivationReceipt,
  GovernedLearningActivationUndoReceipt,
  MemorySlackPublicationConfiguration,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  governedLearningEvidenceIsSlackDerived,
  governedLearningSlackImportance,
  governedLearningSlackProjection,
  publishGovernedLearningEventToSlack,
} from "../src/domain/governed-learning-slack-publication";

const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function activation(
  overrides: Partial<GovernedLearningActivationReceipt> = {},
): GovernedLearningActivationReceipt {
  return {
    id: uuid(1),
    operationId: uuid(2),
    inputHash: HASH,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    decisionReceiptId: uuid(3),
    initiatingHumanSubjectId: "user:human-1",
    serviceActorSubjectId: `service:governed-learning-activation:${HASH}`,
    policyRevisionId: uuid(4),
    policyHash: HASH,
    policyActivationVersion: 1,
    sourceKind: "task-note",
    sourceId: uuid(5),
    sourceAuthorityHash: HASH,
    proposalId: uuid(6),
    claimId: uuid(7),
    evidenceId: uuid(8),
    knowledgePreviousReviewId: uuid(9),
    knowledgePreviousReviewRevision: 1,
    knowledgeApprovalReviewId: uuid(10),
    knowledgeApprovalReviewRevision: 2,
    knowledgeApprovalInputHash: HASH,
    destination: "preference",
    destinationProposalId: uuid(11),
    destinationRevisionId: uuid(12),
    destinationOldRevisionId: null,
    destinationOldContentHash: null,
    destinationOldVersion: 0,
    destinationNewContentHash: HASH,
    destinationNewVersion: 1,
    destinationEventId: uuid(13),
    outcome: "activated",
    effectiveAt: "2026-08-17T10:00:00.000Z",
    rollback: { supported: true, mechanism: "exact_head_and_latest_review" },
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

function undo(): GovernedLearningActivationUndoReceipt {
  return {
    id: uuid(21),
    operationId: uuid(22),
    inputHash: HASH,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    activationReceiptId: uuid(1),
    initiatingHumanSubjectId: "user:human-1",
    serviceActorSubjectId: `service:governed-learning-activation:${HASH}`,
    destination: "preference",
    knowledgeApprovalReviewId: uuid(10),
    knowledgeRevocationReviewId: uuid(23),
    knowledgeRevocationReviewRevision: 3,
    knowledgeRevocationInputHash: HASH,
    destinationActivatedRevisionId: uuid(12),
    destinationRestoredRevisionId: null,
    destinationActivatedContentHash: HASH,
    destinationRestoredContentHash: null,
    destinationOldVersion: 1,
    destinationNewVersion: 2,
    destinationEventId: uuid(24),
    outcome: "undone",
    superseded: false,
    effectiveAt: "2026-08-17T11:00:00.000Z",
    createdAt: "2026-08-17T11:00:00.000Z",
  };
}

function configuration(
  overrides: Partial<MemorySlackPublicationConfiguration> = {},
): MemorySlackPublicationConfiguration {
  return {
    id: uuid(31),
    workspaceId: WORKSPACE_ID,
    revision: 1,
    enabled: true,
    connectionId: uuid(32),
    slackTeamId: "T123",
    slackChannelId: "C123",
    slackChannelName: "learning",
    autoImportances: ["major"],
    reviewImportances: ["normal"],
    createdBySubjectId: "user:admin",
    createdAt: "2026-08-17T09:00:00.000Z",
    ...overrides,
  };
}

describe("governed-learning Slack publication adapter", () => {
  test("classifies preference activation as normal, policy activation and undo as major", () => {
    expect(
      governedLearningSlackImportance({
        kind: "activated",
        receipt: activation(),
        sessionId: null,
        attemptId: null,
      }),
    ).toBe("normal");
    expect(
      governedLearningSlackImportance({
        kind: "activated",
        receipt: activation({ destination: "instruction_policy" }),
        sessionId: null,
        attemptId: null,
      }),
    ).toBe("major");
    expect(governedLearningSlackImportance({ kind: "undone", receipt: undo() })).toBe("major");
  });

  test("projects only content-free facts and identifiers", () => {
    const projection = governedLearningSlackProjection({
      kind: "activated",
      receipt: activation(),
      sessionId: uuid(40),
      attemptId: uuid(41),
    });
    expect(projection).toEqual({
      summary:
        "Automatically activated a workspace preference learned from a task note (revision 1). Undo is available through the workspace learning API.",
      outcome: "activated",
      destination: "preference",
      sourceKind: "task-note",
      destinationRevisionId: uuid(12),
      destinationVersion: 1,
      activationReceiptId: uuid(1),
      undoReceiptId: null,
      occurredAt: "2026-08-17T10:00:00.000Z",
    });
    expect(JSON.stringify(projection)).not.toContain("human-1");
    const undone = governedLearningSlackProjection({ kind: "undone", receipt: undo() });
    expect(undone.summary).toBe(
      "Undid an automatic workspace preference activation (revision 1 → 2).",
    );
    expect(undone.undoReceiptId).toBe(uuid(21));
    expect(undone.activationReceiptId).toBe(uuid(1));
  });

  test("fails closed for Slack-derived evidence and unresolved origins", async () => {
    expect(governedLearningEvidenceIsSlackDerived({ kind: "task-note" })).toBe(false);
    expect(
      governedLearningEvidenceIsSlackDerived({ kind: "document", providerKey: "google-drive" }),
    ).toBe(false);
    expect(governedLearningEvidenceIsSlackDerived({ kind: "document", providerKey: "slack" })).toBe(
      true,
    );
    let enqueues = 0;
    const event = {
      kind: "activated" as const,
      receipt: activation({ sourceKind: "scoped-knowledge-evidence" }),
      sessionId: null,
      attemptId: null,
    };
    const slackDerived = await publishGovernedLearningEventToSlack({} as Database, event, {
      resolveEvidenceOrigin: async () => ({ kind: "document", providerKey: "slack-connector" }),
      configuration: async () => configuration({ autoImportances: ["major", "normal"] }),
      enqueue: async () => {
        enqueues += 1;
        throw new Error("must not enqueue");
      },
    });
    expect(slackDerived).toEqual({ kind: "slack_derived_evidence", enqueue: null });
    const unresolved = await publishGovernedLearningEventToSlack({} as Database, event, {
      resolveEvidenceOrigin: async () => null,
      configuration: async () => configuration({ autoImportances: ["major", "normal"] }),
      enqueue: async () => {
        enqueues += 1;
        throw new Error("must not enqueue");
      },
    });
    expect(unresolved).toEqual({ kind: "evidence_origin_unresolved", enqueue: null });
    expect(enqueues).toBe(0);
  });

  test("stays quiet without an enabled destination or matching importance policy", async () => {
    const event = {
      kind: "activated" as const,
      receipt: activation(),
      sessionId: null,
      attemptId: null,
    };
    for (const config of [
      null,
      configuration({ enabled: false, autoImportances: ["normal"] }),
      configuration({ autoImportances: ["major"], reviewImportances: ["minor"] }),
    ]) {
      const result = await publishGovernedLearningEventToSlack({} as Database, event, {
        resolveEvidenceOrigin: async () => ({ kind: "task-note" }),
        configuration: async () => config,
        enqueue: async () => {
          throw new Error("must not enqueue");
        },
      });
      expect(result).toEqual({ kind: "policy_quiet", enqueue: null });
    }
  });

  test("enqueues an idempotent, service-attributed durable_learning publication", async () => {
    const enqueued: unknown[] = [];
    const result = await publishGovernedLearningEventToSlack(
      {} as Database,
      { kind: "activated", receipt: activation(), sessionId: uuid(40), attemptId: uuid(41) },
      {
        resolveEvidenceOrigin: async () => ({ kind: "task-note" }),
        configuration: async () => configuration({ reviewImportances: ["normal"] }),
        enqueue: async (_db, input) => {
          enqueued.push(input);
          return { kind: "enqueued", publication: {} as never };
        },
      },
    );
    expect(result.kind).toBe("enqueued");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      sourceType: "durable_learning",
      sourceId: uuid(1),
      sourceVersion: "1",
      sourceIdempotencyKey: `governed-learning:activated:${uuid(1)}`,
      importance: "normal",
      deliveryMode: "review",
      actor: {
        kind: "service",
        subjectId: `service:governed-learning-activation:${HASH}`,
        initiatingHumanSubjectId: "user:human-1",
        sessionId: uuid(40),
        attemptId: uuid(41),
      },
    });
    const undone = await publishGovernedLearningEventToSlack(
      {} as Database,
      { kind: "undone", receipt: undo() },
      {
        resolveEvidenceOrigin: async () => {
          throw new Error("undo must not resolve evidence");
        },
        configuration: async () => configuration(),
        enqueue: async (_db, input) => {
          enqueued.push(input);
          return { kind: "enqueued", publication: {} as never };
        },
      },
    );
    expect(undone.kind).toBe("enqueued");
    expect(enqueued[1]).toMatchObject({
      sourceIdempotencyKey: `governed-learning:undone:${uuid(21)}`,
      importance: "major",
      deliveryMode: "auto",
    });
  });
});
