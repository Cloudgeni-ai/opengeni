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
  DurableLearningAttemptInProgressError,
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
      legacyMemory: null,
    },
    evidence: [],
    ...overrides,
  };
}

function memoryLedger() {
  const attempts = new Map<string, DurableLearningAttempt>();
  const receipts = new Map<string, DurableLearningReceipt>();
  const claims = new Map<string, string>();
  let nextClaim = 0;
  const ledger: DurableLearningAttemptLedger = {
    async reserveAttempt(attempt) {
      const existing = attempts.get(attempt.id);
      if (existing && existing.inputHash !== attempt.inputHash) {
        return {
          attempt: existing,
          receipt: receipts.get(attempt.id) ?? null,
          claimId: null,
        };
      }
      attempts.set(attempt.id, attempt);
      const receipt = receipts.get(attempt.id) ?? null;
      if (receipt) return { attempt: existing ?? attempt, receipt, claimId: null };
      if (claims.has(attempt.id)) {
        return { attempt: existing ?? attempt, receipt: null, claimId: null };
      }
      const claimId = `claim-${++nextClaim}`;
      claims.set(attempt.id, claimId);
      return { attempt: existing ?? attempt, receipt: null, claimId };
    },
    async renewAttemptClaim(attempt, claimId) {
      return claims.get(attempt.id) === claimId;
    },
    async completeAttempt(attempt, receipt, claimId) {
      if (claims.get(attempt.id) !== claimId) throw new Error("claim lost");
      receipts.set(attempt.id, receipt);
      claims.delete(attempt.id);
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
      request({
        origin: "legacy_memory_save",
        subject: {
          ...request().subject,
          legacyMemory: { kind: "semantic", confidence: null, pinned: null, metadata: {} },
        },
      }),
      context({ grants: { ...context().grants, activate: false } }),
    );
    expect(result).toMatchObject({
      disposition: "route",
      destination: "memory",
      authority: "active",
    });
  });

  test("preserves legacy procedural Memory without making it canonical preference routing", () => {
    const result = planDurableLearningWrite(
      request({
        origin: "legacy_memory_save",
        subject: {
          ...request().subject,
          kind: "procedure",
          legacyMemory: {
            kind: "procedural",
            confidence: 0.8,
            pinned: false,
            metadata: {},
          },
        },
      }),
      context(),
    );
    expect(result).toMatchObject({
      disposition: "route",
      destination: "memory",
      authority: "active",
    });
    expect(result.reasons.join(" ")).toContain("Legacy preference/procedural Memory");
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
          legacyMemory: null,
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

  test("rejects compatibility-only Memory metadata on canonical explicit writes", () => {
    const result = planDurableLearningWrite(
      request({
        subject: {
          ...request().subject,
          legacyMemory: {
            kind: "preference",
            confidence: 1,
            pinned: true,
            metadata: { source: "legacy-only" },
          },
        },
      }),
      context(),
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      code: "LEGACY_MEMORY_SAVE_CONTRACT_VIOLATION",
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
          legacyMemory: null,
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

  test("does not invoke an authority concurrently for the same pending attempt", async () => {
    const { ledger } = memoryLedger();
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    const ports = {
      ledger,
      now: () => new Date("2026-08-09T16:00:00.000Z"),
      authorities: {
        memory: {
          async write() {
            enteredWrite();
            await writeStarted;
            return {
              outcome: "applied" as const,
              resource: {
                surface: "memory" as const,
                id: "memory-1",
                version: "1",
                status: "active",
              },
              effectiveBoundary: "next_accepted_attempt" as const,
              rollback: { supported: false, targetAttemptId: null, token: null },
            };
          },
          async rollback() {
            throw new Error("not used");
          },
        },
      },
    };

    const first = routeDurableLearning(request(), context(), ports);
    await entered;
    await expect(routeDurableLearning(request(), context(), ports)).rejects.toBeInstanceOf(
      DurableLearningAttemptInProgressError,
    );
    releaseWrite();
    expect((await first).receipt.outcome).toBe("applied");
  });
});
