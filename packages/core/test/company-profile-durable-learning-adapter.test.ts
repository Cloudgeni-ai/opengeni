import { describe, expect, test } from "bun:test";
import type { CompanyProfileLearningWrite } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  createCompanyProfileDurableLearningAdapter,
  type CompanyProfileDurableLearningAdapterOptions,
} from "../src/domain/company-profile-durable-learning-adapter";

const ATTEMPT_ID = "00000000-0000-4000-8000-000000000101";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000102";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000103";
const REVISION_ID = "00000000-0000-4000-8000-000000000104";
const EVENT_ID = "00000000-0000-4000-8000-000000000105";
const NOW = "2026-08-10T00:00:00.000Z";

function routerWriteInput(authority: "active" | "proposal" = "active") {
  return {
    attempt: {
      id: ATTEMPT_ID,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      actor: { kind: "agent", subjectId: "agent:company-profile" },
    },
    request: {
      operation: "write",
      attemptId: ATTEMPT_ID,
      targetSurface: "company_profile",
      subject: {
        kind: "company_goal",
        content: "Ship deterministic organization context.",
        stableKey: "deterministic-context",
      },
    },
    decision: {
      disposition: "route",
      destination: "company_profile",
      scope: { kind: "organization" },
      authority,
    },
  };
}

describe("company-profile durable-learning adapter", () => {
  test("is structurally assignable to the canonical durable-learning router authority adapter and maps writes", async () => {
    let captured: CompanyProfileLearningWrite | null = null;
    const authority: NonNullable<CompanyProfileDurableLearningAdapterOptions["authority"]> = {
      async write(_db, input) {
        captured = input;
        return {
          outcome: input.authority === "active" ? "applied" : "proposed",
          revision: {
            id: REVISION_ID,
            operationId: input.operationId,
            accountId: input.accountId,
            revision: 7,
            intent: input.authority,
            profile: {
              identity: null,
              mission: null,
              products: [],
              customers: [],
              goals: [{ key: "deterministic-context", content: input.subject.content }],
              constraints: [],
            },
            contentHash: "a".repeat(64),
            provenance: { source: "durable_learning", sourceId: input.sourceId },
            supersedesRevisionId: null,
            createdBySubjectId: input.actorSubjectId,
            createdAt: NOW,
          },
          head: null,
          effectiveBoundary: "next_accepted_attempt",
          rollbackToken:
            input.authority === "active" ? `company-profile.v1:none:${REVISION_ID}` : null,
        };
      },
      async rollback() {
        throw new Error("rollback was not expected");
      },
    };
    const adapter = createCompanyProfileDurableLearningAdapter({
      db: {} as Database,
      authority,
    });

    type CanonicalDurableLearningAdapterShape = {
      write: (input: { attempt: unknown; request: unknown; decision: unknown }) => Promise<{
        outcome: "applied" | "proposed" | "evidence_recorded" | "noop";
        resource: {
          surface: "company_profile";
          id: string;
          version: string | null;
          status: string;
        } | null;
        effectiveBoundary: "immediate" | "next_accepted_attempt" | "not_applicable";
        rollback: { supported: boolean; targetAttemptId: string | null; token: string | null };
      }>;
      rollback: (input: unknown) => Promise<{
        resource: {
          surface: "company_profile";
          id: string;
          version: string | null;
          status: string;
        } | null;
        effectiveBoundary: "immediate" | "next_accepted_attempt" | "not_applicable";
      }>;
    };
    const compatible: CanonicalDurableLearningAdapterShape = adapter;
    const result = await compatible.write(routerWriteInput());

    expect(captured).toMatchObject({
      operationId: ATTEMPT_ID,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      actorSubjectId: "agent:company-profile",
      actorKind: "agent",
      authority: "active",
      sourceId: `durable-learning-attempt:${ATTEMPT_ID}`,
      subject: { kind: "company_goal", stableKey: "deterministic-context" },
    });
    expect(result).toMatchObject({
      outcome: "applied",
      resource: { surface: "company_profile", id: REVISION_ID, version: "7", status: "active" },
      effectiveBoundary: "next_accepted_attempt",
      rollback: { supported: true, targetAttemptId: null },
    });

    const proposal = await adapter.write(routerWriteInput("proposal"));
    expect(proposal).toMatchObject({
      outcome: "proposed",
      resource: { status: "proposal" },
      rollback: { supported: false, token: null },
    });
  });

  test("maps rollback attempts to the canonical authority operation id", async () => {
    let operationId: string | null = null;
    const authority: NonNullable<CompanyProfileDurableLearningAdapterOptions["authority"]> = {
      async write() {
        throw new Error("write was not expected");
      },
      async rollback(_db, input) {
        operationId = input.operationId;
        return {
          revision: null,
          head: null,
          event: {
            id: EVENT_ID,
            operationId: input.operationId,
            accountId: input.accountId,
            type: "rollback",
            activationVersion: 8,
            oldRevision: {
              id: REVISION_ID,
              revision: 7,
              contentHash: "a".repeat(64),
            },
            newRevision: null,
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
            createdAt: NOW,
          },
        };
      },
    };
    const adapter = createCompanyProfileDurableLearningAdapter({
      db: {} as Database,
      authority,
    });
    const result = await adapter.rollback({
      attempt: {
        id: ATTEMPT_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        actor: { kind: "human", subjectId: "human:company-admin" },
      },
      targetAttempt: {
        id: "00000000-0000-4000-8000-000000000106",
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        actor: { kind: "agent", subjectId: "agent:company-profile" },
      },
      targetReceipt: {
        attemptId: "00000000-0000-4000-8000-000000000106",
        resource: { surface: "company_profile", id: REVISION_ID, version: "7", status: "active" },
        rollback: {
          supported: true,
          token: `company-profile.v1:none:${REVISION_ID}`,
        },
      },
      rollbackToken: `company-profile.v1:none:${REVISION_ID}`,
      reason: "Undo exact routed write",
    });

    expect(operationId).toBe(ATTEMPT_ID);
    expect(result).toEqual({
      resource: {
        surface: "company_profile",
        id: REVISION_ID,
        version: "8",
        status: "inactive",
      },
      effectiveBoundary: "next_accepted_attempt",
    });
  });

  test("fails closed for a non-company or non-organization decision", async () => {
    const adapter = createCompanyProfileDurableLearningAdapter({ db: {} as Database });
    await expect(
      adapter.write({
        ...routerWriteInput(),
        decision: {
          destination: "memory",
          scope: { kind: "workspace" },
          authority: "active",
        },
      }),
    ).rejects.toThrow(
      "accepts only matching routed active or proposal organization company_profile writes",
    );
  });
});
