import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import { checkLimit, requireLimit } from "../src/billing/limits";
import {
  creationInitiatorForGrant,
  initiatingHumanForAllowance,
  retryFailedSession,
} from "../src/domain/sessions";
import type { ApiRouteDeps } from "../src/dependencies";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const HUMAN = "user:initiating-human";
const RESET = "2026-10-01T00:00:00.000Z";
const deps = {
  db: {} as opengeniDb.Database,
  settings: testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
};
const input = {
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  action: "agent_run:create" as const,
  model: "scripted-model",
  quantity: 1,
  initiatingHumanSubjectId: HUMAN,
};

describe("core usage allowance admission", () => {
  let allowance: ReturnType<typeof spyOn<typeof opengeniDb, "checkWorkspaceAllowance">>;
  let balance: ReturnType<typeof spyOn<typeof opengeniDb, "getBillingBalance">>;
  let codex: ReturnType<typeof spyOn<typeof opengeniDb, "isCodexBilledTurn">>;

  beforeEach(() => {
    allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
    balance = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: ACCOUNT,
      balanceMicros: 1,
      currency: "usd",
      updatedAt: "2026-09-30T00:00:00.000Z",
    });
    codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(false);
  });

  afterEach(() => {
    allowance.mockRestore();
    balance.mockRestore();
    codex.mockRestore();
  });

  test.each(["workspace", "member"] as const)(
    "returns typed %s exhaustion and HTTP 402 with the immutable refusal",
    async (scope) => {
      const refusal = {
        code: "allowance_exhausted" as const,
        scope,
        resetsAt: RESET,
        ...(scope === "member" ? { subjectId: HUMAN } : {}),
        message: `The ${scope} usage allowance is exhausted.`,
      };
      allowance.mockResolvedValue(refusal);
      expect(await checkLimit(deps, input)).toEqual({ allowed: false, ...refusal });
      try {
        await requireLimit(deps, input);
        throw new Error("expected allowance refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPException);
        expect(error).toMatchObject({
          status: 402,
          message: refusal.message,
          cause: { allowed: false, ...refusal },
        });
      }
      expect(allowance).toHaveBeenLastCalledWith(deps.db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: HUMAN,
      });
    },
  );

  test.each(["agent_run:create", "tokens:consume"] as const)(
    "checks credit-debited %s even without static or managed usage caps",
    async (action) => {
      const uncapped = {
        ...deps,
        settings: testSettings({ billingMode: "disabled", usageLimitsMode: "none" }),
      };
      expect(await checkLimit(uncapped, { ...input, action, quantity: 0 })).toEqual({
        allowed: true,
      });
      expect(allowance).toHaveBeenCalledTimes(1);
      expect(balance).not.toHaveBeenCalled();
    },
  );

  test("pure service admission checks the workspace without a member", async () => {
    await requireLimit(deps, { ...input, initiatingHumanSubjectId: null });
    expect(allowance).toHaveBeenCalledWith(deps.db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      subjectId: null,
    });
  });

  test.each([HUMAN, null])(
    "retry uses the original frozen human %s rather than the retrying administrator",
    async (originalHuman) => {
      const sessionId = "00000000-0000-4000-8000-000000000003";
      const turnId = "00000000-0000-4000-8000-000000000004";
      const failureId = "00000000-0000-4000-8000-000000000005";
      const workspaceRls = spyOn(
        opengeniDb,
        "withWorkspaceSubjectSessionActivityRls",
      ).mockImplementation(async (db, _workspaceId, _subjectId, fn) => await fn(db as never));
      const slack = spyOn(
        opengeniDb,
        "getSlackInteractionSessionAccessForSession",
      ).mockResolvedValue(null);
      const authority = spyOn(opengeniDb, "getSessionAuthorityProjection").mockResolvedValue(null);
      const replay = spyOn(opengeniDb, "getSessionRetryReceiptInTransaction").mockResolvedValue(
        null,
      );
      const session = spyOn(opengeniDb, "requireSession").mockResolvedValue({
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
      } as Awaited<ReturnType<typeof opengeniDb.requireSession>>);
      const failure = spyOn(opengeniDb, "getSessionEvent").mockResolvedValue({
        sessionId,
        turnId,
      } as Awaited<ReturnType<typeof opengeniDb.getSessionEvent>>);
      const turn = spyOn(opengeniDb, "getSessionTurn").mockResolvedValue({
        id: turnId,
        model: "scripted-model",
        initiator: { kind: "service", subjectId: "scheduler" },
      } as Awaited<ReturnType<typeof opengeniDb.getSessionTurn>>);
      const human = spyOn(opengeniDb, "getSessionTurnInitiatingHumanSubjectId").mockResolvedValue(
        originalHuman,
      );
      const policy = spyOn(opengeniDb, "getWorkspaceModelPolicy").mockResolvedValue(null);
      allowance.mockResolvedValue({
        code: "allowance_exhausted",
        scope: originalHuman ? "member" : "workspace",
        resetsAt: RESET,
        ...(originalHuman ? { subjectId: originalHuman } : {}),
        message: "Exhausted",
      });
      try {
        await expect(
          retryFailedSession(
            deps as ApiRouteDeps,
            {
              accountId: ACCOUNT,
              workspaceId: WORKSPACE,
              subjectId: "user:retrying-administrator",
              permissions: ["sessions:control"],
              principalKind: "human_session",
            },
            WORKSPACE,
            sessionId,
            {
              clientEventId: crypto.randomUUID(),
              failureEventId: failureId,
            },
          ),
        ).rejects.toMatchObject({ status: 402, cause: { code: "allowance_exhausted" } });
        expect(human).toHaveBeenCalledWith(deps.db, WORKSPACE, turnId);
        expect(allowance).toHaveBeenCalledWith(deps.db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: originalHuman,
        });
      } finally {
        workspaceRls.mockRestore();
        slack.mockRestore();
        authority.mockRestore();
        replay.mockRestore();
        session.mockRestore();
        failure.mockRestore();
        turn.mockRestore();
        human.mockRestore();
        policy.mockRestore();
      }
    },
  );

  test.each([
    {
      model: "codex/gpt-5.6-sol",
      codexBilled: true,
      overrides: { codexSubscriptionEnabled: true },
    },
    {
      model: "supergrok/grok-4.7",
      codexBilled: false,
      overrides: { supergrokSubscriptionEnabled: true },
    },
    {
      model: "scripted-model",
      codexBilled: false,
      overrides: { modelCostPolicyJson: '{"scripted-model":"free"}' },
    },
  ])(
    "exempts externally funded $model from allowance checks",
    async ({ model, codexBilled, overrides }) => {
      codex.mockResolvedValue(codexBilled);
      allowance.mockResolvedValue({
        code: "allowance_exhausted",
        scope: "workspace",
        resetsAt: null,
        message: "Exhausted",
      });
      await requireLimit(
        {
          ...deps,
          settings: testSettings({
            billingMode: "stripe",
            usageLimitsMode: "managed",
            ...overrides,
          }),
        },
        { ...input, model },
      );
      expect(allowance).not.toHaveBeenCalled();
      expect(balance).not.toHaveBeenCalled();
    },
  );

  test.each([
    "workspace:create",
    "api_key:create",
    "schedule:create",
    "file:upload",
    "document:index",
  ] as const)("does not charge non-credit action %s against the allowance", async (action) => {
    await requireLimit(deps, { ...input, action, model: undefined });
    expect(allowance).not.toHaveBeenCalled();
  });
});

describe("allowance human attribution", () => {
  test.each(["service", "api_key", "configured_key"] as const)(
    "freezes %s as service work without accepting a human allowance owner",
    (principalKind) => {
      expect(
        creationInitiatorForGrant({
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: "machine:caller",
          permissions: ["sessions:create", "sessions:control"],
          principalKind,
        }),
      ).toEqual({
        initiator: { kind: "service", subjectId: "machine:caller" },
        context: {},
      });
    },
  );
  test("keeps the frozen human even when its initiator is a scheduler service", () => {
    expect(
      initiatingHumanForAllowance({
        initiator: { kind: "service", subjectId: "scheduler" },
        initiatingHumanSubjectId: HUMAN,
      }),
    ).toBe(HUMAN);
  });

  test("never treats an API key or pure service as a member", () => {
    expect(
      initiatingHumanForAllowance({
        initiator: { kind: "subject", subjectId: "api_key:key-id" },
        initiatingHumanSubjectId: null,
      }),
    ).toBeNull();
    expect(
      initiatingHumanForAllowance({
        initiator: { kind: "subject", subjectId: "configured-machine" },
        initiatingHumanSubjectId: null,
      }),
    ).toBeNull();
    expect(
      initiatingHumanForAllowance({
        initiator: { kind: "service", subjectId: "scheduler" },
        initiatingHumanSubjectId: null,
      }),
    ).toBeNull();
  });

  test("retains a legacy accepted subject rather than the retrying caller", () => {
    expect(
      initiatingHumanForAllowance({
        initiator: { kind: "subject", subjectId: HUMAN },
      }),
    ).toBe(HUMAN);
  });
});
