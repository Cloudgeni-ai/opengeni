import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import { ModelCallError } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import * as runtimeModelCall from "@opengeni/runtime/model-call";
import { testSettings } from "@opengeni/testing/settings";
import * as rls from "../src/access-grant-rls";
import { PendingUsageSettlements } from "../src/model-calls/pending-usage-settlements";
import { createModelCallService } from "../src/model-calls/service";

// A single model call on the person's own subscription pays no platform fee
// but needs a paid plan; on their own API key it pays the fee. The service
// tells admission which one it is from the served route.
const ACCOUNT = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000b2";
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function spy<T extends object, K extends keyof T>(target: T, key: K, impl: unknown) {
  const mocked = spyOn(target, key as never).mockImplementation(impl as never);
  restores.push(() => mocked.mockRestore());
  return mocked;
}

const ROUTES = {
  subscription: {
    credentialSource: { kind: "connected_subscription", provider: "codex" },
    billing: { metering: "external", upstreamPayer: "connected_subscription" },
  },
  apiKey: {
    credentialSource: { kind: "organization_connection", mechanism: "api_key" },
    billing: { metering: "external", upstreamPayer: "organization" },
  },
  deployment: {
    credentialSource: { kind: "deployment" },
    billing: { metering: "external", upstreamPayer: "deployment" },
  },
} as const;

function harness(
  route: keyof typeof ROUTES,
  admission?: Record<string, unknown>,
  origin: "app" | "api" = "app",
) {
  const settings = testSettings({ billingMode: "stripe", subscriptionPlansEnabled: true });
  const selection = {
    model: {
      id: "own-model",
      label: "Own",
      providerLabel: "Own",
      ...ROUTES[route],
      capabilities: { inputModalities: ["text"], structuredOutput: { runnable: true } },
    },
  };
  spy(
    rls,
    "withAccessGrantSessionRlsContext",
    async (_d: unknown, _g: unknown, fn: () => unknown) => fn(),
  );
  spy(rls, "billingOriginForAccessGrant", async () => origin);
  spy(core, "resolveWorkspaceCatalogSettings", async () => ({ settings }));
  spy(core, "resolveCallerWorkspaceModelSelections", async () => [selection]);
  spy(core, "admissibleWorkspaceModel", () => selection);
  const realAdmission = core.admitModelCall;
  const admit = spy(
    core,
    "admitModelCall",
    async (...args: Parameters<typeof realAdmission>) =>
      admission ?? (await realAdmission(...args)),
  );
  const provider = spy(runtimeModelCall, "runSingleModelCall", async () => {
    throw new Error("must not dispatch");
  });
  const service = createModelCallService({
    db: {} as Database,
    settings,
    pendingUsageSettlements: new PendingUsageSettlements({ schedule: () => undefined }),
  });
  const call = () =>
    service
      .call({
        grant: {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: "user:alice",
          permissions: [],
          principalKind: "human_session",
        },
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: "user:alice",
        model: "own-model",
        request: { messages: [{ role: "user", content: "hi" }] } as never,
        requestId: "req-own",
      } as never)
      .catch((caught: unknown) => caught);
  return { admit, provider, call };
}

describe("single model calls on the person's own model", () => {
  test("API callers receive a clear refusal before a subscription credential or provider is used", async () => {
    const h = harness("subscription", undefined, "api");
    expect(await h.call()).toMatchObject({
      status: 403,
      type: "invalid_request_error",
      code: "subscription_api_unavailable",
      message:
        "Connected subscriptions are only available in the Opengeni apps. Choose a credit-billed model for API use.",
    });
    expect(h.provider).not.toHaveBeenCalled();
  });
  test("an own subscription is admitted as a subscription, never byok, and Free is refused with the upgrade code", async () => {
    const h = harness("subscription", {
      allowed: false,
      denial: "insufficient_credits",
      subscriptionPlanRequired: true,
      message: "Upgrade to Pro to use your own subscription.",
    });
    const error = await h.call();
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit.mock.calls[0]![1]).toMatchObject({ byok: false, ownSubscription: true });
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      status: 402,
      type: "insufficient_quota",
      code: "subscription_plan_required",
    });
    expect(h.provider).not.toHaveBeenCalled();
  });

  test("an own API key is admitted as byok (it pays the fee); a deployment model is neither", async () => {
    const refused = {
      allowed: false,
      denial: "insufficient_credits",
      byokPaidCreditRequired: true,
      message: "Add credits to use your own key.",
    };
    const own = harness("apiKey", refused);
    expect(await own.call()).toMatchObject({ code: "byok_paid_credit_required" });
    expect(own.admit.mock.calls[0]![1]).toMatchObject({ byok: true, ownSubscription: false });
    while (restores.length > 0) restores.pop()?.();
    const deployment = harness("deployment", {
      allowed: false,
      denial: "insufficient_credits",
      message: "no credits",
    });
    await deployment.call();
    expect(deployment.admit.mock.calls[0]![1]).toMatchObject({
      byok: false,
      ownSubscription: false,
    });
  });
});
