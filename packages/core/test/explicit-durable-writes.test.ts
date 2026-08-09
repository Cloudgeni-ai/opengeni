import { describe, expect, test } from "bun:test";
import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
  type DurableLearningAttempt,
  type DurableLearningAuthorityContext,
  type DurableLearningReceipt,
  type DurableLearningRouterResponse,
  type ExplicitDurableWriteBinding,
  type ExplicitDurableWriteCommand,
} from "@opengeni/contracts";
import {
  DurableLearningAttemptConflictError,
  routeDurableLearning,
  type DurableLearningAttemptLedger,
  type DurableLearningRouterPorts,
} from "../src/domain/durable-learning-router";
import {
  ExplicitDurableWriteBindingError,
  projectExplicitDurableWriteReceipt,
  toExplicitDurableLearningRouterRequest,
} from "../src/domain/explicit-durable-writes";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const CHILD_SESSION_ID = "30000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const HUMAN_ID = "human@example.com";
const CONTENT_HASH = "a".repeat(64);

function context(
  overrides: Partial<DurableLearningAuthorityContext> = {},
): DurableLearningAuthorityContext {
  return {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "agent", subjectId: "agent:session" },
    initiatingHumanSubjectId: HUMAN_ID,
    sessionId: SESSION_ID,
    grants: {
      organization: true,
      workspace: true,
      selfUser: true,
      roleKeys: [],
      sessionIds: [SESSION_ID, CHILD_SESSION_ID],
      ephemeralSessionIds: [SESSION_ID, CHILD_SESSION_ID],
      activate: true,
    },
    learningPolicy: null,
    availableSurfaces: {
      memory: true,
      preferenceRegistry: true,
      instructionPolicy: true,
      companyProfile: true,
      documentsEvidence: true,
    },
    ...overrides,
  };
}

function binding(
  overrides: Partial<ExplicitDurableWriteBinding> = {},
): ExplicitDurableWriteBinding {
  return {
    attemptId: ATTEMPT_ID,
    sessionId: SESSION_ID,
    sourceMessage: {
      id: "session-message-42",
      version: "7",
      contentHash: CONTENT_HASH,
    },
    ...overrides,
  };
}

function command(
  overrides: Partial<ExplicitDurableWriteCommand> = {},
): ExplicitDurableWriteCommand {
  return {
    contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
    operation: "remember",
    scope: "workspace",
    subject: {
      intent: "decision",
      content: "Use one canonical durable-learning router.",
      stableKey: null,
      title: null,
      summary: null,
      replacesResourceId: null,
    },
    ...overrides,
  } as ExplicitDurableWriteCommand;
}

function memoryLedger() {
  const attempts = new Map<string, DurableLearningAttempt>();
  const receipts = new Map<string, DurableLearningReceipt>();
  const ledger: DurableLearningAttemptLedger = {
    async reserveAttempt(attempt) {
      const existing = attempts.get(attempt.id);
      if (existing) return { attempt: existing, receipt: receipts.get(attempt.id) ?? null };
      attempts.set(attempt.id, attempt);
      return { attempt, receipt: null };
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

function successfulAdapter(
  surface: "memory" | "preference_registry" | "instruction_policy" | "company_profile",
) {
  return {
    async write() {
      return {
        outcome: "applied" as const,
        resource: { surface, id: `${surface}-1`, version: "1", status: "active" },
        effectiveBoundary: "next_accepted_attempt" as const,
        rollback: {
          supported: true,
          targetAttemptId: null,
          token: `${surface}:opaque-rollback-token`,
        },
      };
    },
    async rollback() {
      return {
        resource: { surface, id: `${surface}-1`, version: "2", status: "superseded" },
        effectiveBoundary: "next_accepted_attempt" as const,
      };
    },
  };
}

function ports(overrides: Partial<DurableLearningRouterPorts> = {}): DurableLearningRouterPorts {
  return {
    ledger: memoryLedger().ledger,
    now: () => new Date("2026-08-09T16:00:00.000Z"),
    authorities: {
      memory: successfulAdapter("memory"),
      preference_registry: successfulAdapter("preference_registry"),
      instruction_policy: successfulAdapter("instruction_policy"),
      company_profile: successfulAdapter("company_profile"),
    },
    ...overrides,
  };
}

async function route(
  explicitCommand: ExplicitDurableWriteCommand,
  explicitBinding = binding(),
  authorityContext = context(),
  routerPorts = ports(),
): Promise<{
  request: ReturnType<typeof toExplicitDurableLearningRouterRequest>;
  response: DurableLearningRouterResponse;
}> {
  const request = toExplicitDurableLearningRouterRequest(
    explicitCommand,
    explicitBinding,
    authorityContext,
  );
  return {
    request,
    response: await routeDurableLearning(request, authorityContext, routerPorts),
  };
}

describe("explicit durable write router translation", () => {
  test("maps personal, workspace, and company intents to existing authorities", () => {
    const cases = [
      {
        command: command({ scope: "personal", subject: { ...command().subject, intent: "fact" } }),
        destination: "memory",
        scope: { kind: "user", subjectId: HUMAN_ID },
      },
      {
        command: command({
          subject: {
            ...command().subject,
            intent: "procedure",
            stableKey: "verification.focused-first",
            title: "Focused verification first",
            summary: "Run focused checks before broad validation.",
          },
        }),
        destination: "preference_registry",
        scope: { kind: "workspace" },
      },
      {
        command: command({
          subject: { ...command().subject, intent: "workspace_goal" },
        }),
        destination: "instruction_policy",
        scope: { kind: "workspace" },
      },
      {
        command: command({
          scope: "company",
          subject: { ...command().subject, intent: "company_mission" },
        }),
        destination: "company_profile",
        scope: { kind: "organization" },
      },
      {
        command: command({
          scope: "company",
          subject: {
            ...command().subject,
            intent: "skill_guidance",
            stableKey: "delivery.release-train",
            title: "Use one release train",
            summary: "Promote one exact immutable release artifact.",
          },
        }),
        destination: "preference_registry",
        scope: { kind: "organization" },
      },
    ] as const;

    for (const item of cases) {
      const request = toExplicitDurableLearningRouterRequest(item.command, binding(), context());
      expect(request.operation).toBe("write");
      if (request.operation !== "write") throw new Error("expected write request");
      expect(request.origin).toBe("explicit_remember");
      expect(request.requestedAuthority).toBe("active");
      expect(request.targetSurface).toBe(item.destination);
      expect(request.requestedScope).toEqual(item.scope);
      expect(request.evidence).toEqual([
        {
          kind: "session_message",
          sourceId: "session-message-42",
          sourceVersion: "7",
          contentHash: CONTENT_HASH,
          eligibility: "eligible",
        },
      ]);
    }
  });

  test("routes an authorized command as active with next-attempt effect and a transparent receipt", async () => {
    const routed = await route(command());
    expect(routed.response.receipt.decision).toMatchObject({
      disposition: "route",
      destination: "memory",
      authority: "active",
    });
    expect(routed.response.receipt.effectiveBoundary).toBe("next_accepted_attempt");

    const publicReceipt = projectExplicitDurableWriteReceipt(routed.request, routed.response);
    expect(publicReceipt).toMatchObject({
      operation: "remember",
      outcome: "applied",
      saved: {
        destination: "memory",
        scope: { kind: "workspace" },
        authority: "active",
      },
      inspect: { surface: "memory", resourceId: "memory-1", version: "1" },
      undo: { supported: true, targetAttemptId: ATTEMPT_ID },
      audit: { sourceEvidence: [{ sourceId: "session-message-42", contentHash: CONTENT_HASH }] },
    });
    expect(JSON.stringify(publicReceipt)).not.toContain("opaque-rollback-token");
  });

  test("returns a deterministic immutable clarification when scope is genuinely unspecified", async () => {
    const { ledger } = memoryLedger();
    let authorityCalls = 0;
    const routerPorts = ports({
      ledger,
      authorities: {
        memory: {
          async write() {
            authorityCalls += 1;
            return successfulAdapter("memory").write();
          },
          async rollback() {
            return successfulAdapter("memory").rollback();
          },
        },
      },
    });
    const first = await route(command({ scope: "unspecified" }), binding(), context(), routerPorts);
    const replay = await route(
      command({ scope: "unspecified" }),
      binding(),
      context(),
      routerPorts,
    );

    expect(first.response.receipt).toMatchObject({
      outcome: "clarification_required",
      decision: {
        disposition: "clarification_required",
        code: "SCOPE_REQUIRED",
        clarificationFields: ["requestedScope"],
      },
    });
    expect(replay.response.idempotency).toBe("replayed");
    expect(replay.response.receipt).toEqual(first.response.receipt);
    expect(authorityCalls).toBe(0);
  });

  test("refuses unauthorized company escalation without downgrading to a proposal", async () => {
    let companyCalls = 0;
    const { response } = await route(
      command({
        scope: "company",
        subject: { ...command().subject, intent: "company_goal" },
      }),
      binding(),
      context({ grants: { ...context().grants, organization: false } }),
      ports({
        authorities: {
          company_profile: {
            async write() {
              companyCalls += 1;
              return successfulAdapter("company_profile").write();
            },
            async rollback() {
              return successfulAdapter("company_profile").rollback();
            },
          },
        },
      }),
    );
    expect(response.receipt).toMatchObject({
      outcome: "rejected",
      decision: { code: "SCOPE_NOT_AUTHORIZED", authority: null },
    });
    expect(companyCalls).toBe(0);
  });

  test("refuses a scope/intent mismatch and an unavailable company authority deterministically", async () => {
    const mismatch = await route(
      command({
        scope: "company",
        subject: { ...command().subject, intent: "fact" },
      }),
    );
    expect(mismatch.response.receipt.decision.code).toBe("SCOPE_NOT_SUPPORTED_BY_SURFACE");

    const unavailable = await route(
      command({
        scope: "company",
        subject: { ...command().subject, intent: "company_constraint" },
      }),
      binding(),
      context({
        availableSurfaces: { ...context().availableSurfaces, companyProfile: false },
      }),
    );
    expect(unavailable.response.receipt.decision.code).toBe("SURFACE_NOT_AVAILABLE");
  });

  test("retries and duplicate delivery replay one immutable attempt without a second authority call", async () => {
    const { ledger } = memoryLedger();
    let calls = 0;
    const routerPorts = ports({
      ledger,
      authorities: {
        memory: {
          async write() {
            calls += 1;
            return successfulAdapter("memory").write();
          },
          async rollback() {
            return successfulAdapter("memory").rollback();
          },
        },
      },
    });
    const first = await route(command(), binding(), context(), routerPorts);
    const duplicate = await route(command(), binding(), context(), routerPorts);
    expect(first.response.idempotency).toBe("created");
    expect(duplicate.response.idempotency).toBe("replayed");
    expect(duplicate.response.receipt).toEqual(first.response.receipt);
    expect(calls).toBe(1);
  });

  test("rejects one attempt id reused for a changed explicit command", async () => {
    const { ledger } = memoryLedger();
    const routerPorts = ports({ ledger });
    await route(command(), binding(), context(), routerPorts);
    await expect(
      route(
        command({ subject: { ...command().subject, content: "Changed immutable content." } }),
        binding(),
        context(),
        routerPorts,
      ),
    ).rejects.toBeInstanceOf(DurableLearningAttemptConflictError);
  });

  test("forwards correction lineage and routes undo back to the same authority", async () => {
    const { ledger } = memoryLedger();
    let replacedResourceId: string | null | undefined;
    let rollbackCalls = 0;
    const routerPorts = ports({
      ledger,
      authorities: {
        memory: {
          async write({ request }) {
            replacedResourceId = request.subject.replacesResourceId;
            return successfulAdapter("memory").write();
          },
          async rollback({ targetReceipt, rollbackToken }) {
            rollbackCalls += 1;
            expect(targetReceipt.attemptId).toBe(ATTEMPT_ID);
            expect(rollbackToken).toBe("memory:opaque-rollback-token");
            return successfulAdapter("memory").rollback();
          },
        },
      },
    });
    await route(
      command({
        subject: { ...command().subject, replacesResourceId: "memory-old" },
      }),
      binding(),
      context(),
      routerPorts,
    );
    expect(replacedResourceId).toBe("memory-old");

    const undoCommand: ExplicitDurableWriteCommand = {
      contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
      operation: "undo",
      targetAttemptId: ATTEMPT_ID,
      reason: "The remembered decision was incorrect.",
    };
    const undoBinding = binding({ attemptId: "40000000-0000-4000-8000-000000000002" });
    const undone = await route(undoCommand, undoBinding, context(), routerPorts);
    expect(undone.request).toMatchObject({
      contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
      operation: "rollback",
      origin: "explicit_remember",
      targetAttemptId: ATTEMPT_ID,
    });
    expect(undone.response.receipt).toMatchObject({
      outcome: "rolled_back",
      decision: { destination: "memory" },
      effectiveBoundary: "next_accepted_attempt",
    });
    expect(rollbackCalls).toBe(1);
    expect(
      JSON.stringify(projectExplicitDurableWriteReceipt(undone.request, undone.response)),
    ).not.toContain("opaque-rollback-token");
  });

  test("requires source-message evidence for remember but not for router-native undo", () => {
    expect(() =>
      toExplicitDurableLearningRouterRequest(
        command(),
        binding({ sourceMessage: null }),
        context(),
      ),
    ).toThrow(ExplicitDurableWriteBindingError);

    const undo: ExplicitDurableWriteCommand = {
      contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
      operation: "undo",
      targetAttemptId: ATTEMPT_ID,
      reason: "Undo through the original authority.",
    };
    expect(
      toExplicitDurableLearningRouterRequest(undo, binding({ sourceMessage: null }), context()),
    ).toMatchObject({ operation: "rollback", targetAttemptId: ATTEMPT_ID });
  });

  test("preserves initiating-human authority in nested sessions", async () => {
    const childContext = context({
      actor: { kind: "agent", subjectId: "agent:child" },
      sessionId: CHILD_SESSION_ID,
    });
    const childBinding = binding({ sessionId: CHILD_SESSION_ID });
    const request = toExplicitDurableLearningRouterRequest(
      command({ scope: "personal", subject: { ...command().subject, intent: "observation" } }),
      childBinding,
      childContext,
    );
    expect(request.operation).toBe("write");
    if (request.operation !== "write") throw new Error("expected write request");
    expect(request.requestedScope).toEqual({ kind: "user", subjectId: HUMAN_ID });

    const { response } = await route(
      command({ scope: "personal", subject: { ...command().subject, intent: "observation" } }),
      childBinding,
      childContext,
    );
    expect(response.receipt.decision.code).toBe("ROUTED");
  });

  test("fails closed when host source binding and frozen session authority diverge", () => {
    expect(() =>
      toExplicitDurableLearningRouterRequest(
        command(),
        binding({ sessionId: CHILD_SESSION_ID }),
        context(),
      ),
    ).toThrow(ExplicitDurableWriteBindingError);
    expect(() =>
      toExplicitDurableLearningRouterRequest(
        command({ scope: "personal" }),
        binding(),
        context({ initiatingHumanSubjectId: null }),
      ),
    ).toThrow(ExplicitDurableWriteBindingError);
  });
});
