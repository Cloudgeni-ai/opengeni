import { describe, expect, test } from "bun:test";
import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  type DurableLearningAttempt,
  type DurableLearningAuthorityContext,
  type DurableLearningReceipt,
  type DurableLearningWriteRequest,
} from "@opengeni/contracts";
import {
  DurableLearningAttemptConflictError,
  planDurableLearningWrite,
  routeDurableLearning,
  type DurableLearningAttemptLedger,
} from "../src/domain/durable-learning-router";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const SESSION_ID = "40000000-0000-4000-8000-000000000001";

function context(
  overrides: Partial<DurableLearningAuthorityContext> = {},
): DurableLearningAuthorityContext {
  return {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "agent", subjectId: "agent:session" },
    initiatingHumanSubjectId: "human@example.com",
    sessionId: SESSION_ID,
    grants: {
      organization: false,
      workspace: true,
      selfUser: true,
      roleKeys: [],
      sessionIds: [SESSION_ID],
      ephemeralSessionIds: [SESSION_ID],
      activate: true,
    },
    learningPolicy: null,
    availableSurfaces: {
      memory: true,
      preferenceRegistry: true,
      instructionPolicy: true,
      companyProfile: false,
      documentsEvidence: true,
    },
    ...overrides,
  };
}

function request(
  overrides: Partial<DurableLearningWriteRequest> = {},
): DurableLearningWriteRequest {
  return {
    contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
    operation: "write",
    attemptId: ATTEMPT_ID,
    origin: "explicit_remember",
    requestedAuthority: "active",
    requestedScope: { kind: "workspace" },
    targetSurface: "memory",
    subject: {
      kind: "decision",
      content: "Use the canonical durable-learning router.",
      stableKey: null,
      title: null,
      summary: null,
      roleKey: null,
      replacesResourceId: null,
    },
    evidence: [],
    ...overrides,
  };
}

function memoryLedger() {
  const attempts = new Map<string, DurableLearningAttempt>();
  const receipts = new Map<string, DurableLearningReceipt>();
  const ledger: DurableLearningAttemptLedger = {
    async reserveAttempt(attempt) {
      const existing = attempts.get(attempt.id);
      if (existing && existing.inputHash !== attempt.inputHash) {
        return { attempt: existing, receipt: receipts.get(attempt.id) ?? null };
      }
      attempts.set(attempt.id, attempt);
      return { attempt, receipt: receipts.get(attempt.id) ?? null };
    },
    async completeAttempt(attempt, receipt) {
      receipts.set(attempt.id, receipt);
      return receipt;
    },
    async getCompletedAttempt(accountId, workspaceId, attemptId) {
      const attempt = attempts.get(attemptId);
      const receipt = receipts.get(attemptId);
      if (
        !attempt ||
        !receipt ||
        attempt.accountId !== accountId ||
        attempt.workspaceId !== workspaceId
      ) {
        return null;
      }
      return { attempt, receipt };
    },
  };
  return { ledger, attempts, receipts };
}

describe("durable learning route planner", () => {
  test("preserves legacy memory_save as an active workspace Memory write", () => {
    const result = planDurableLearningWrite(
      request({ origin: "legacy_memory_save" }),
      context({ grants: { ...context().grants, activate: false } }),
    );
    expect(result).toMatchObject({
      disposition: "route",
      destination: "memory",
      authority: "active",
    });
  });

  test("routes procedures only to the preference registry", () => {
    const result = planDurableLearningWrite(
      request({
        targetSurface: "preference_registry",
        requestedAuthority: "proposal",
        subject: {
          kind: "procedure",
          content: "Run focused checks before the full suite.",
          stableKey: "verification.focused-first",
          title: "Focused verification first",
          summary: "Run targeted checks before broad validation.",
          roleKey: null,
          replacesResourceId: null,
        },
      }),
      context(),
    );
    expect(result).toMatchObject({
      disposition: "route",
      destination: "preference_registry",
      authority: "proposal",
    });
  });

  test("downgrades autonomous activation under suggest mode", () => {
    const result = planDurableLearningWrite(
      request({ origin: "autonomous_learning" }),
      context({
        learningPolicy: { mode: "suggest", snapshotId: "snapshot-1", revisionId: "revision-1" },
      }),
    );
    expect(result).toMatchObject({
      disposition: "route",
      authority: "proposal",
      policySnapshotId: "snapshot-1",
    });
  });

  test("fails closed for unavailable organization company profile authority", () => {
    const result = planDurableLearningWrite(
      request({
        requestedScope: { kind: "organization" },
        targetSurface: "company_profile",
        subject: {
          kind: "company_mission",
          content: "Make autonomous infrastructure work dependable.",
          stableKey: null,
          title: null,
          summary: null,
          roleKey: null,
          replacesResourceId: null,
        },
      }),
      context({ grants: { ...context().grants, organization: true } }),
    );
    expect(result).toMatchObject({ disposition: "rejected", code: "SURFACE_NOT_AVAILABLE" });
  });

  test("returns deterministic clarification fields instead of guessing", () => {
    const result = planDurableLearningWrite(
      request({
        requestedScope: { kind: "unspecified" },
        requestedAuthority: "unspecified",
        targetSurface: "unspecified",
      }),
      context(),
    );
    expect(result).toMatchObject({
      disposition: "clarification_required",
      clarificationFields: ["requestedScope", "requestedAuthority", "targetSurface"],
    });
  });
});

describe("durable learning router service", () => {
  test("invokes exactly one authority and replays the immutable receipt", async () => {
    const { ledger } = memoryLedger();
    let calls = 0;
    const ports = {
      ledger,
      now: () => new Date("2026-08-09T16:00:00.000Z"),
      authorities: {
        memory: {
          async write() {
            calls += 1;
            return {
              outcome: "applied" as const,
              resource: {
                surface: "memory" as const,
                id: "memory-1",
                version: "1",
                status: "active",
              },
              effectiveBoundary: "next_accepted_attempt" as const,
              rollback: { supported: true, targetAttemptId: null, token: "memory:memory-1:1" },
            };
          },
          async rollback() {
            throw new Error("not used");
          },
        },
      },
    };

    const first = await routeDurableLearning(request(), context(), ports);
    const replay = await routeDurableLearning(request(), context(), ports);
    expect(first.idempotency).toBe("created");
    expect(replay.idempotency).toBe("replayed");
    expect(replay.receipt).toEqual(first.receipt);
    expect(calls).toBe(1);
  });

  test("rejects an attempt id replayed with changed input", async () => {
    const { ledger } = memoryLedger();
    const ports = { ledger, authorities: {} };
    await routeDurableLearning(request(), context(), ports);
    await expect(
      routeDurableLearning(
        request({ subject: { ...request().subject, content: "Different content" } }),
        context(),
        ports,
      ),
    ).rejects.toBeInstanceOf(DurableLearningAttemptConflictError);
  });
});
