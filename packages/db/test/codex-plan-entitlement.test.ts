import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  CODEX_PLAN_ENTITLEMENT_MAX_MODELS,
  codexPlanExcludesModel,
  mergeCodexPlanEntitlementExclusion,
  readCodexPlanEntitlementExclusion,
} from "../src/codex-plan-entitlement";
import { unresolvedCodexCredentialFailures } from "../src/codex-failure-eligibility";
import {
  recheckCodexCredentialPlan,
  type CodexAuthDeps,
  type CodexCredentialForRun,
} from "../src/codex-token-resolver";
import type { Database } from "../src/database";

describe("Codex plan entitlement exclusion", () => {
  test("applies only to the listed model under the plan it was observed with", () => {
    const exclusion = { planType: "free", modelIds: ["codex/gpt-6-sol"] };
    expect(
      codexPlanExcludesModel(
        { planType: "free", planEntitlementExclusion: exclusion },
        "codex/gpt-6-sol",
      ),
    ).toBe(true);
    expect(
      codexPlanExcludesModel(
        { planType: "Free", planEntitlementExclusion: exclusion },
        "codex/gpt-6-sol",
      ),
    ).toBe(true);
    expect(
      codexPlanExcludesModel(
        { planType: "free", planEntitlementExclusion: exclusion },
        "codex/gpt-6-luna",
      ),
    ).toBe(false);
    // A later observation of a different plan (an upgrade) makes it inert.
    expect(
      codexPlanExcludesModel(
        { planType: "pro", planEntitlementExclusion: exclusion },
        "codex/gpt-6-sol",
      ),
    ).toBe(false);
    expect(codexPlanExcludesModel({ planType: "free" }, "codex/gpt-6-sol")).toBe(false);
  });

  test("merges models under one plan and replaces an exclusion from another plan", () => {
    const first = mergeCodexPlanEntitlementExclusion(null, "Free", "codex/gpt-6-sol");
    expect(first).toEqual({ planType: "free", modelIds: ["codex/gpt-6-sol"] });
    expect(mergeCodexPlanEntitlementExclusion(first, "free", "codex/gpt-6-astra")).toEqual({
      planType: "free",
      modelIds: ["codex/gpt-6-astra", "codex/gpt-6-sol"],
    });
    expect(mergeCodexPlanEntitlementExclusion(first, "free", "codex/gpt-6-sol")).toEqual(first);
    expect(mergeCodexPlanEntitlementExclusion(first, "plus", "codex/gpt-6-astra")).toEqual({
      planType: "plus",
      modelIds: ["codex/gpt-6-astra"],
    });
    expect(mergeCodexPlanEntitlementExclusion(null, null, "codex/gpt-6-sol").planType).toBe(
      "unknown",
    );
    let bounded = mergeCodexPlanEntitlementExclusion(null, "free", "codex/m-0");
    for (let index = 1; index < CODEX_PLAN_ENTITLEMENT_MAX_MODELS + 5; index += 1) {
      bounded = mergeCodexPlanEntitlementExclusion(bounded, "free", `codex/m-${index}`);
    }
    expect(bounded.modelIds).toHaveLength(CODEX_PLAN_ENTITLEMENT_MAX_MODELS);
  });

  test("reads stored values strictly", () => {
    expect(readCodexPlanEntitlementExclusion(null)).toBeNull();
    expect(readCodexPlanEntitlementExclusion({ planType: "free", modelIds: [] })).toBeNull();
    expect(readCodexPlanEntitlementExclusion({ planType: 3, modelIds: ["a"] })).toBeNull();
    expect(readCodexPlanEntitlementExclusion("not json")).toBeNull();
    expect(readCodexPlanEntitlementExclusion('{"planType":"free","modelIds":["a","a",7]}')).toEqual(
      { planType: "free", modelIds: ["a"] },
    );
  });

  test("a plan refusal stays excluded for the turn until a different plan is observed", () => {
    const metadata = {
      codexCredentialFailedIds: ["cred-free"],
      codexCredentialFailureEvidenceV1: {
        "cred-free": { kind: "plan", credentialVersion: 3, planType: "free" },
      },
    };
    const account = (planType: string | null) => ({
      id: "cred-free",
      status: "active",
      exhaustedUntil: null,
      exhaustedKind: null,
      credentialVersion: 3,
      planType,
    });
    expect(unresolvedCodexCredentialFailures(metadata, [account("free")])).toEqual(["cred-free"]);
    expect(unresolvedCodexCredentialFailures(metadata, [account("pro")])).toEqual([]);
    expect(
      unresolvedCodexCredentialFailures(metadata, [{ ...account("pro"), status: "error" }]),
    ).toEqual(["cred-free"]);
  });
});

describe("recheckCodexCredentialPlan", () => {
  const db = {} as Database;
  const settings = testSettings({ codexSubscriptionEnabled: true });

  function credential(overrides: Partial<CodexCredentialForRun> = {}): CodexCredentialForRun {
    return {
      id: "cred_1",
      version: 1,
      workspaceId: "ws_1",
      tokens: { accessToken: "AC", refreshToken: "RF", idToken: "ID" },
      chatgptAccountId: "acct_1",
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRefreshAt: new Date(),
      status: "active",
      lastError: null,
      exhaustedUntil: null,
      exhaustedKind: null,
      exhaustedRevision: 0,
      ...overrides,
    };
  }

  function idToken(planType: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1", chatgpt_plan_type: planType },
    })}.sig`;
  }

  function deps(overrides: Partial<CodexAuthDeps> = {}) {
    const calls = { refresh: 0, usageWrites: [] as unknown[], refreshPlans: [] as unknown[] };
    let current = credential();
    const value: CodexAuthDeps = {
      loadCredential: async () => current,
      recordRefresh: async (_db, input) => {
        calls.refreshPlans.push(input.planType);
        current = credential({ version: input.version + 1, planType: input.planType ?? "pro" });
        return true;
      },
      setStatus: async () => true,
      refresh: async () => {
        calls.refresh += 1;
        return { accessToken: "AC2", refreshToken: "RF2", idToken: idToken("free") };
      },
      encrypt: () => "v1:enc",
      keyBytes: () => new Uint8Array(32),
      withRefreshLock: async (lockedDb, _workspaceId, _credentialId, fn) => await fn(lockedDb),
      recordUsage: async (_db, _workspaceId, _credentialId, snapshot) => {
        calls.usageWrites.push(snapshot);
        return true;
      },
      ...overrides,
    };
    return { deps: value, calls };
  }

  const usageResponse = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  test("prefers /wham/usage plan_type and persists it without rotating tokens", async () => {
    const { deps: d, calls } = deps();
    const result = await recheckCodexCredentialPlan(
      db,
      settings,
      "ws_recheck_usage",
      "cred_1",
      d,
      usageResponse({ plan_type: "free" }),
    );
    expect(result).toEqual({
      previousPlanType: "pro",
      planType: "free",
      source: "usage",
      credentialVersion: 1,
    });
    expect(calls.refresh).toBe(0);
    expect(calls.usageWrites).toEqual([
      expect.objectContaining({ planType: "free", planCheckedAt: expect.any(Date) }),
    ]);
  });

  test("falls back to one forced token refresh when usage reports no plan", async () => {
    const { deps: d, calls } = deps();
    const result = await recheckCodexCredentialPlan(
      db,
      settings,
      "ws_recheck_refresh",
      "cred_1",
      d,
      usageResponse({}),
    );
    expect(result).toEqual({
      previousPlanType: "pro",
      planType: "free",
      source: "token_refresh",
      credentialVersion: 2,
    });
    expect(calls.refresh).toBe(1);
    expect(calls.refreshPlans).toEqual(["free"]);
  });

  test("reports an unknown plan instead of throwing when both sources fail", async () => {
    const { deps: d } = deps({
      refresh: async () => {
        throw new Error("network down");
      },
    });
    const result = await recheckCodexCredentialPlan(
      db,
      settings,
      "ws_recheck_unknown",
      "cred_1",
      d,
      usageResponse({ error: "nope" }, 500),
    );
    expect(result).toEqual({
      previousPlanType: "pro",
      planType: null,
      source: null,
      credentialVersion: 1,
    });
  });
});
