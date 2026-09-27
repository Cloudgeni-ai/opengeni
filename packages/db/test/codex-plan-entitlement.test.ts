import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS,
  CODEX_PLAN_ENTITLEMENT_MAX_MODELS,
  activeCodexPlanExclusions,
  codexPlanExcludesModel,
  codexPlanPreviouslyExcludedModel,
  mergeCodexPlanEntitlementExclusion,
  readCodexPlanEntitlementExclusion,
  serializeCodexPlanEntitlementExclusion,
} from "../src/codex-plan-entitlement";
import { unresolvedCodexCredentialFailures } from "../src/codex-failure-eligibility";
import {
  buildCodexTokenResolver,
  recheckCodexCredentialPlan,
  type CodexAuthDeps,
  type CodexCredentialForRun,
} from "../src/codex-token-resolver";
import type { Database } from "../src/database";

describe("Codex plan entitlement exclusion", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
  const exclusion = (excludedAt: Date, planType = "free") => ({
    planType,
    models: [{ modelId: "codex/gpt-6-sol", excludedAt }],
  });

  test("applies only to the listed model under the plan it was observed with", () => {
    const current = exclusion(hoursAgo(1));
    const excludes = (planType: string, modelId: string) =>
      codexPlanExcludesModel({ planType, planEntitlementExclusion: current }, modelId, now);
    expect(excludes("free", "codex/gpt-6-sol")).toBe(true);
    expect(excludes("Free", "codex/gpt-6-sol")).toBe(true);
    expect(excludes("free", "codex/gpt-6-luna")).toBe(false);
    // A later observation of a different plan (an upgrade) makes it inert.
    expect(excludes("pro", "codex/gpt-6-sol")).toBe(false);
    expect(codexPlanExcludesModel({ planType: "free" }, "codex/gpt-6-sol", now)).toBe(false);
  });

  test("expires after the TTL but stays evidence for the same plan and model", () => {
    const account = (excludedAt: Date) => ({
      planType: "free",
      planEntitlementExclusion: exclusion(excludedAt),
    });
    const ttlHours = CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS / (60 * 60 * 1000);
    expect(codexPlanExcludesModel(account(hoursAgo(ttlHours - 1)), "codex/gpt-6-sol", now)).toBe(
      true,
    );
    expect(codexPlanExcludesModel(account(hoursAgo(ttlHours + 1)), "codex/gpt-6-sol", now)).toBe(
      false,
    );
    expect(
      codexPlanPreviouslyExcludedModel(account(hoursAgo(ttlHours + 1)), "codex/gpt-6-sol"),
    ).toBe(true);
    expect(
      codexPlanPreviouslyExcludedModel(
        { planType: "pro", planEntitlementExclusion: exclusion(hoursAgo(1)) },
        "codex/gpt-6-sol",
      ),
    ).toBe(false);
    expect(activeCodexPlanExclusions(account(hoursAgo(1)), now)).toEqual([
      {
        modelId: "codex/gpt-6-sol",
        excludedAt: hoursAgo(1),
        expiresAt: new Date(hoursAgo(1).getTime() + CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS),
      },
    ]);
    expect(activeCodexPlanExclusions(account(hoursAgo(ttlHours + 1)), now)).toEqual([]);
  });

  test("merges models under one plan and replaces an exclusion from another plan", () => {
    const first = mergeCodexPlanEntitlementExclusion(null, "Free", "codex/gpt-6-sol", hoursAgo(2));
    expect(first).toEqual({
      planType: "free",
      models: [{ modelId: "codex/gpt-6-sol", excludedAt: hoursAgo(2) }],
    });
    expect(mergeCodexPlanEntitlementExclusion(first, "free", "codex/gpt-6-astra", now)).toEqual({
      planType: "free",
      models: [
        { modelId: "codex/gpt-6-astra", excludedAt: now },
        { modelId: "codex/gpt-6-sol", excludedAt: hoursAgo(2) },
      ],
    });
    // A repeated refusal refreshes the exclusion time.
    expect(mergeCodexPlanEntitlementExclusion(first, "free", "codex/gpt-6-sol", now)).toEqual({
      planType: "free",
      models: [{ modelId: "codex/gpt-6-sol", excludedAt: now }],
    });
    expect(mergeCodexPlanEntitlementExclusion(first, "plus", "codex/gpt-6-astra", now)).toEqual({
      planType: "plus",
      models: [{ modelId: "codex/gpt-6-astra", excludedAt: now }],
    });
    expect(mergeCodexPlanEntitlementExclusion(null, null, "codex/gpt-6-sol", now).planType).toBe(
      "unknown",
    );
    let bounded = mergeCodexPlanEntitlementExclusion(null, "free", "codex/m-0", hoursAgo(100));
    for (let index = 1; index < CODEX_PLAN_ENTITLEMENT_MAX_MODELS + 5; index += 1) {
      bounded = mergeCodexPlanEntitlementExclusion(
        bounded,
        "free",
        `codex/m-${index}`,
        hoursAgo(100 - index),
      );
    }
    expect(bounded.models).toHaveLength(CODEX_PLAN_ENTITLEMENT_MAX_MODELS);
    // The oldest refusals fall off first.
    expect(bounded.models.some((entry) => entry.modelId === "codex/m-0")).toBe(false);
  });

  test("reads and serializes stored values strictly", () => {
    expect(readCodexPlanEntitlementExclusion(null)).toBeNull();
    expect(readCodexPlanEntitlementExclusion({ planType: "free", models: [] })).toBeNull();
    expect(
      readCodexPlanEntitlementExclusion({
        planType: 3,
        models: [{ modelId: "a", excludedAt: now.toISOString() }],
      }),
    ).toBeNull();
    // The pre-release `modelIds` shape carries no refusal time: ignored.
    expect(readCodexPlanEntitlementExclusion({ planType: "free", modelIds: ["a"] })).toBeNull();
    expect(readCodexPlanEntitlementExclusion("not json")).toBeNull();
    const stored = JSON.stringify({
      planType: "free",
      models: [
        { modelId: "a", excludedAt: hoursAgo(2).toISOString() },
        { modelId: "a", excludedAt: hoursAgo(1).toISOString() },
        { modelId: "b", excludedAt: "not a date" },
        7,
      ],
    });
    const read = readCodexPlanEntitlementExclusion(stored);
    expect(read).toEqual({ planType: "free", models: [{ modelId: "a", excludedAt: hoursAgo(1) }] });
    expect(serializeCodexPlanEntitlementExclusion(read!)).toEqual({
      planType: "free",
      models: [{ modelId: "a", excludedAt: hoursAgo(1).toISOString() }],
    });
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
    // A refusal recorded without a fresh plan observation names no plan, so no
    // later observation makes the account eligible again within this turn.
    const unobserved = {
      ...metadata,
      codexCredentialFailureEvidenceV1: {
        "cred-free": { kind: "plan", credentialVersion: 3, planType: null },
      },
    };
    expect(unresolvedCodexCredentialFailures(unobserved, [account("pro")])).toEqual(["cred-free"]);
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
    // Mirrors codexPlanObservationSet: a different plan records the change
    // and retires the exclusion; the same plan keeps both.
    const observe = (planType: string, at: Date) => {
      if (current.planType !== null && current.planType !== planType) {
        current = {
          ...current,
          planType,
          planPreviousType: current.planType,
          planChangedAt: at,
          planEntitlementExclusion: null,
        };
      } else {
        current = { ...current, planType };
      }
    };
    const value: CodexAuthDeps = {
      loadCredential: async () => current,
      recordRefresh: async (_db, input) => {
        calls.refreshPlans.push(input.planType);
        current = { ...current, version: input.version + 1 };
        if (input.planType) observe(input.planType, input.lastRefreshAt);
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
        if (snapshot.planType) observe(snapshot.planType, snapshot.planCheckedAt ?? new Date());
        return true;
      },
      ...overrides,
    };
    return {
      deps: value,
      calls,
      seed: (fields: Partial<CodexCredentialForRun>) => {
        current = credential(fields);
      },
    };
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
      planChangedFrom: "pro",
      planChangedAt: expect.any(Date),
      exclusion: null,
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
      planChangedFrom: "pro",
      planChangedAt: expect.any(Date),
      exclusion: null,
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
      planChangedFrom: null,
      planChangedAt: null,
      exclusion: null,
    });
  });

  test("keeps a plan change another observer recorded first", async () => {
    // A usage read on the accounts page already saw Pro -> Plus. The failing
    // turn's re-check sees Plus again, yet still gets the recorded change.
    const changedAt = new Date("2026-09-26T08:00:00.000Z");
    const { deps: d, seed } = deps();
    seed({ planType: "plus", planPreviousType: "pro", planChangedAt: changedAt });
    const result = await recheckCodexCredentialPlan(
      db,
      settings,
      "ws_recheck_recorded",
      "cred_1",
      d,
      usageResponse({ plan_type: "plus" }),
    );
    expect(result).toMatchObject({
      previousPlanType: "plus",
      planType: "plus",
      planChangedFrom: "pro",
      planChangedAt: changedAt,
    });
  });
});

describe("token refresh plan observation", () => {
  test("wakes capacity waiters after the refresh lock when it retires an exclusion", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const idToken = `${encode({ alg: "none" })}.${encode({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1", chatgpt_plan_type: "pro" },
    })}.sig`;
    const events: string[] = [];
    let current: CodexCredentialForRun = {
      id: "cred_wake",
      version: 1,
      workspaceId: "ws_wake",
      tokens: { accessToken: "AC", refreshToken: "RF", idToken: "ID" },
      chatgptAccountId: "acct_1",
      scopes: null,
      planType: "free",
      planEntitlementExclusion: {
        planType: "free",
        models: [{ modelId: "codex/gpt-6-sol", excludedAt: new Date() }],
      },
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRefreshAt: new Date(),
      status: "active",
      lastError: null,
      exhaustedUntil: null,
      exhaustedKind: null,
      exhaustedRevision: 0,
    };
    const d: CodexAuthDeps = {
      loadCredential: async () => current,
      recordRefresh: async (_db, input) => {
        events.push(`record:${input.planType}`);
        current = { ...current, version: input.version + 1, planType: input.planType ?? null };
        return true;
      },
      setStatus: async () => true,
      refresh: async () => ({ accessToken: "AC2", refreshToken: "RF2", idToken }),
      encrypt: () => "v1:enc",
      keyBytes: () => new Uint8Array(32),
      withRefreshLock: async (lockedDb, _workspaceId, _credentialId, fn) => {
        events.push("lock");
        const value = await fn(lockedDb);
        events.push("unlock");
        return value;
      },
      onPlanExclusionRetired: async (_db, workspaceId, credentialId) => {
        events.push(`wake:${workspaceId}:${credentialId}`);
      },
    };
    await buildCodexTokenResolver(
      {} as Database,
      testSettings({ codexSubscriptionEnabled: true }),
      "ws_wake",
      "cred_wake",
      d,
    ).refresh();
    expect(events).toEqual(["lock", "record:pro", "unlock", "wake:ws_wake:cred_wake"]);
  });
});
