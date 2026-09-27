import { describe, expect, test } from "bun:test";
import { CODEX_TRANSPORT_ERROR_HEADER } from "@opengeni/codex";
import {
  CodexPlanEntitlementError,
  assessCodexPlanEntitlement,
  codexAccountDisplayLabel,
  codexPlanEntitlementAdmissionBlock,
  codexPlanEntitlementFailurePayload,
  codexRequestRejectedFailurePayload,
} from "../src/activities/agent-turn/codex-plan-entitlement";
import {
  agentRunFailurePayload,
  classifyCodexCredentialFailure,
} from "../src/activities/agent-turn/errors";
import { selectCodexCredentialLeaseForTurn } from "../src/activities/codex-rotation";

const model = "codex/gpt-6-sol";
const freeExclusion = { planType: "free", modelIds: [model] };

function account(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    accountEmail: `${id}@example.test`,
    planType: "pro",
    allocatorEnabled: true,
    allowedModelIds: null,
    planEntitlementExclusion: null,
    ...overrides,
  };
}

function transportError(status: number, body?: Record<string, unknown>) {
  return Object.assign(
    new Error(body ? `${status} ${JSON.stringify(body)}` : `${status} status code (no body)`),
    { status, error: body, headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }) },
  );
}

describe("Codex plan entitlement copy", () => {
  test("names the account, the new plan, and the model", () => {
    expect(
      codexPlanEntitlementFailurePayload({
        accountLabel: "Work Pro",
        planType: "free",
        planChanged: true,
        modelId: model,
      }),
    ).toEqual({
      error:
        'The ChatGPT account "Work Pro" is now on the Free plan, which doesn\'t include GPT-6 Sol. ' +
        "Upgrade it, use another connected account, or choose another model.",
      code: "codex_plan_entitlement",
      retryable: false,
      planType: "free",
      model,
    });
  });

  test("stays truthful without a label, a plan, or a model", () => {
    expect(
      codexPlanEntitlementFailurePayload({
        accountLabel: null,
        planType: null,
        planChanged: false,
        modelId: null,
      }).error,
    ).toBe(
      "The connected ChatGPT account no longer has access to this model on its current plan. " +
        "Upgrade it, use another connected account, or choose another model.",
    );
    expect(
      codexRequestRejectedFailurePayload({
        accountLabel: null,
        planType: null,
        rejection: { status: 400, evidence: "empty_body" },
        planChecked: false,
      }).error,
    ).toBe(
      "The Codex backend rejected this request (HTTP 400) without an error message. " +
        "Try again, or choose another model if it keeps failing.",
    );
  });

  test("prefers the user's label, then the account email", () => {
    expect(codexAccountDisplayLabel({ label: " Work ", accountEmail: "a@example.test" })).toBe(
      "Work",
    );
    expect(codexAccountDisplayLabel({ label: null, accountEmail: "a@example.test" })).toBe(
      "a@example.test",
    );
    expect(codexAccountDisplayLabel(undefined)).toBeNull();
  });
});

describe("Codex plan entitlement assessment", () => {
  test("a Free re-check explains an empty 400 and records whether the plan moved", () => {
    expect(
      assessCodexPlanEntitlement(
        { status: 400, evidence: "empty_body" },
        { previousPlanType: "pro", planType: "free", source: "usage", credentialVersion: 4 },
      ),
    ).toEqual({
      kind: "entitlement_lost",
      planType: "free",
      planChanged: true,
      credentialVersion: 4,
    });
  });

  test("an unchanged paid plan or an unknown plan leaves an empty 400 unexplained", () => {
    expect(
      assessCodexPlanEntitlement(
        { status: 400, evidence: "empty_body" },
        { previousPlanType: "pro", planType: "pro", source: "usage", credentialVersion: 1 },
      ),
    ).toEqual({ kind: "unexplained", planType: "pro" });
    expect(
      assessCodexPlanEntitlement(
        { status: 400, evidence: "empty_body" },
        { previousPlanType: "pro", planType: null, source: null, credentialVersion: 1 },
      ).kind,
    ).toBe("unexplained");
  });
});

describe("Codex plan entitlement admission", () => {
  const base = {
    modelId: model,
    credentialId: null,
    rotationEnabled: true,
    activeCredentialId: "a",
    pinnedCredentialId: null,
    pinSource: null,
  } as const;

  test("blocks a manual pin whose plan excludes the model, even with other accounts", () => {
    const accounts = [
      account("a", { planType: "free", planEntitlementExclusion: freeExclusion }),
      account("b"),
    ];
    expect(
      codexPlanEntitlementAdmissionBlock({
        ...base,
        accounts,
        pinnedCredentialId: "a",
        pinSource: "manual",
      })?.map((candidate) => candidate.id),
    ).toEqual(["a"]);
  });

  test("blocks a rotation-off active account whose plan excludes the model", () => {
    const accounts = [
      account("a", { planType: "free", planEntitlementExclusion: freeExclusion }),
      account("b"),
    ];
    expect(
      codexPlanEntitlementAdmissionBlock({ ...base, accounts, rotationEnabled: false })?.map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["a"]);
  });

  test("blocks rotation only when every allocatable account is plan-excluded", () => {
    const excluded = account("a", { planType: "free", planEntitlementExclusion: freeExclusion });
    expect(
      codexPlanEntitlementAdmissionBlock({ ...base, accounts: [excluded, account("b")] }),
    ).toBeNull();
    expect(
      codexPlanEntitlementAdmissionBlock({
        ...base,
        accounts: [excluded, account("b", { allocatorEnabled: false })],
      })?.map((candidate) => candidate.id),
    ).toEqual(["a"]);
    // A policy pin is a sharded home, not user intent.
    expect(
      codexPlanEntitlementAdmissionBlock({
        ...base,
        accounts: [excluded, account("b")],
        pinnedCredentialId: "a",
        pinSource: "policy",
      }),
    ).toBeNull();
  });

  test("never blocks a selected credential, another model, or an upgraded plan", () => {
    const excluded = account("a", { planType: "free", planEntitlementExclusion: freeExclusion });
    expect(
      codexPlanEntitlementAdmissionBlock({ ...base, accounts: [excluded], credentialId: "a" }),
    ).toBeNull();
    expect(
      codexPlanEntitlementAdmissionBlock({
        ...base,
        accounts: [excluded],
        modelId: "codex/gpt-6-luna",
      }),
    ).toBeNull();
    expect(
      codexPlanEntitlementAdmissionBlock({
        ...base,
        accounts: [account("a", { planType: "pro", planEntitlementExclusion: freeExclusion })],
      }),
    ).toBeNull();
  });
});

describe("Codex plan entitlement allocation", () => {
  test("the allocator skips a plan-excluded account for that model only", () => {
    const leaseAccount = (id: string, overrides: Record<string, unknown> = {}) => ({
      ...account(id, overrides),
      chatgptAccountId: id,
      status: "active",
      isActive: id === "a",
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
      primaryUsedPercent: 0,
      primaryResetAt: null,
      secondaryUsedPercent: 0,
      secondaryResetAt: null,
      usageCheckedAt: null,
      exhaustedUntil: null,
      exhaustedKind: null,
      activeLeaseCount: 0,
      selectionCount: 0,
      lastSelectedAt: null,
    });
    const select = (modelId: string) =>
      selectCodexCredentialLeaseForTurn({
        context: {
          accounts: [
            leaseAccount("a", { planType: "free", planEntitlementExclusion: freeExclusion }),
            leaseAccount("b"),
          ] as never,
          activeCredentialId: "a",
          rotationEnabled: false,
          rotationStrategy: "sharded",
          existingCredentialId: "a",
          modelId,
          policyScope: null,
          unavailableDiagnostics: [],
        },
        sessionId: "session-1",
        sessionPinnedCredentialId: null,
        sessionPinSource: null,
        sessionLastCredentialId: null,
        now: new Date(),
      });
    // Even the existing same-turn lease is not reused for the excluded model.
    expect(select(model).credentialId).toBeNull();
    expect(select("codex/gpt-6-luna").credentialId).toBe("a");
  });
});

describe("Codex entitlement failures outside settlement", () => {
  test("an empty 400 is never a credential failure and never surfaces the raw SDK text", () => {
    const error = transportError(400);
    expect(classifyCodexCredentialFailure(error)).toBeNull();
    expect(agentRunFailurePayload(error, { isCodexTurn: true })).toEqual({
      error:
        "The Codex backend rejected this request (HTTP 400) without an error message. " +
        "Try again, or choose another model if it keeps failing.",
      code: "codex_request_rejected",
      retryable: false,
      planType: null,
      detail: "The Codex backend answered HTTP 400 with no error body.",
    });
  });

  test("an explicit plan 403 is plan evidence, not a forbidden account", () => {
    const error = transportError(403, {
      code: "model_not_available_on_plan",
      message: "This model is not available on your current plan.",
    });
    expect(classifyCodexCredentialFailure(error)).toBeNull();
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "codex_plan_entitlement",
      retryable: false,
    });
    expect(classifyCodexCredentialFailure(transportError(403, { code: "forbidden" }))).toEqual({
      kind: "forbidden",
      cooldownSeconds: null,
    });
  });

  test("admission refusals carry their typed payload", () => {
    const payload = codexPlanEntitlementFailurePayload({
      accountLabel: "Solo",
      planType: "free",
      planChanged: false,
      modelId: model,
    });
    expect(agentRunFailurePayload(new CodexPlanEntitlementError(payload))).toEqual(payload);
  });
});
