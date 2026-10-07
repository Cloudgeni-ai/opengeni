import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyQuotaObservation,
  authorizationIneligibility,
  cacheLifetimeMs,
  connectionIneligibility,
  decidePlacement,
  DEFAULT_IDLE_CUTOFF_MS,
  effectiveSettings,
  failoverCandidateModels,
  isAuthorizationIneligibility,
  isCacheWarm,
  mapReasoningLevel,
  modelPermitted,
  quotaCapacity,
  quotaObservationApplies,
  rankConnections,
  spreadHash,
  type PlacementInput,
  type SubscriptionConnection,
  type SubscriptionQuota,
  type SubscriptionSettingValues,
} from "../src/index";

const NOW = 10_000_000;

function quota(patch: Partial<SubscriptionQuota> = {}): SubscriptionQuota {
  return {
    windows: [{ id: "primary", usedPercent: 20, resetsAt: NOW + 3_600_000, status: "ok" }],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 1,
    observedAt: NOW - 1_000,
    observedRefreshGeneration: 1,
    source: "usage_endpoint",
    ...patch,
  };
}

function connection(
  id: string,
  provider: string,
  patch: Partial<SubscriptionConnection> = {},
): SubscriptionConnection {
  return {
    id,
    provider,
    kind: "subscription",
    ownership: { kind: "shared", scope: { kind: "organization" }, managedByWorkspaceId: null },
    health: "healthy",
    allocatorEnabled: true,
    entitledModelIds: null,
    excludedModelIds: [],
    allowedModelIds: null,
    refreshGeneration: 1,
    quota: quota(),
    ...patch,
  };
}

const SETTINGS: SubscriptionSettingValues = {
  rotation: {},
  providers: {},
  crossProviderFailover: true,
  fallbackOrder: { "codex/a": ["claude/a"] },
  personalConnectionsAllowed: true,
  personalFallbackAllowed: true,
};

function input(patch: {
  settings?: Partial<SubscriptionSettingValues>;
  session?: Partial<PlacementInput["session"]>;
  workspace?: Partial<PlacementInput["workspace"]>;
  connections?: SubscriptionConnection[];
  personalFallbackOptIn?: boolean;
  now?: number;
}): PlacementInput {
  return {
    now: patch.now ?? NOW,
    workspace: {
      id: "ws-team",
      kind: "shared",
      ownerMembershipId: null,
      allowedModelIds: null,
      ...patch.workspace,
    },
    session: {
      id: "session-1",
      workspaceId: patch.workspace?.id ?? "ws-team",
      visibility: "shared",
      ownerMembershipId: "member-a",
      preferredModelId: "codex/a",
      reasoningLevel: "high",
      binding: null,
      onlyThisModel: false,
      reselectionPoints: [],
      personalAuthority: [],
      compactionProviderLock: null,
      ...patch.session,
    },
    settings: { ...SETTINGS, ...patch.settings },
    people: [
      {
        membershipId: "member-a",
        active: true,
        personalFallbackOptIn: patch.personalFallbackOptIn ?? false,
      },
    ],
    models: [
      { id: "codex/a", provider: "codex", reasoningLevels: ["low", "medium", "high", "xhigh"] },
      { id: "codex/b", provider: "codex", reasoningLevels: ["low", "medium", "high"] },
      { id: "claude/a", provider: "claude", reasoningLevels: ["low", "medium", "high", "max"] },
    ],
    connections: patch.connections ?? [connection("codex-1", "codex")],
    cacheFacts: {
      codex: { kind: "measured_idle_cutoff", cutoffMs: null },
      claude: { kind: "exact_ttl", ttlMs: 300_000 },
    },
  };
}

const personal = (id: string, provider: string, patch: Partial<SubscriptionConnection> = {}) =>
  connection(id, provider, {
    ownership: { kind: "personal", ownerMembershipId: "member-a" },
    ...patch,
  });

describe("effective settings", () => {
  test("SUB-SET-02, SUB-SET-03: workspace rows override map entries individually and locks win", () => {
    const resolved = effectiveSettings(
      {
        organization: {
          ...SETTINGS,
          rotation: {
            codex: { mode: "primary_first", primaryConnectionId: "codex-1" },
            claude: { mode: "spread" },
          },
        },
        locked: ["personalFallbackAllowed"],
        workspaces: {
          "ws-team": {
            rotation: { codex: { mode: "spread" } },
            providers: { codex: { useOrganizationAccounts: false, enabled: true } },
            personalFallbackAllowed: false,
            crossProviderFailover: false,
          },
        },
      },
      "ws-team",
    );
    expect(resolved.values.rotation).toEqual({
      codex: { mode: "spread" },
      claude: { mode: "spread" },
    });
    expect(resolved.sources.rotation).toEqual({ codex: "workspace", claude: "organization" });
    expect(resolved.values.providers.codex).toEqual({
      inferenceSource: "workspace",
      useOrganizationAccounts: false,
      enabled: true,
    });
    expect(resolved.sources.providers).toEqual({ codex: "workspace" });
    expect(resolved.values.personalFallbackAllowed).toBe(true);
    expect(resolved.sources.personalFallbackAllowed).toBe("organization");
    expect(resolved.values.crossProviderFailover).toBe(false);
    expect(resolved.sources.crossProviderFailover).toBe("workspace");
  });

  test("SUB-SET-03: a locked map-valued setting ignores every workspace entry", () => {
    const resolved = effectiveSettings(
      {
        organization: SETTINGS,
        locked: ["providers"],
        workspaces: {
          "ws-team": { providers: { codex: { useOrganizationAccounts: true, enabled: false } } },
        },
      },
      "ws-team",
    );
    expect(resolved.values.providers).toEqual({});
  });
});

describe("provider switches", () => {
  test("M3 inference source resolves legacy aliases and source-specific assignment membership", () => {
    const workspaceAccount = connection("codex-local", "codex", {
      ownership: {
        kind: "shared",
        scope: { kind: "organization" },
        managedByWorkspaceId: "ws-team",
      },
      assignmentPolicies: [
        {
          workspaceId: "ws-team",
          inferencePool: "workspace",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: true,
        },
      ],
    });
    const organizationAccount = connection("codex-org", "codex", {
      assignmentPolicies: [
        {
          workspaceId: "ws-team",
          inferencePool: "organization",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: true,
        },
      ],
    });
    const localFirst = input({
      settings: {
        rotation: { codex: { mode: "primary_first", primaryConnectionId: "codex-local" } },
        providers: { codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true } },
      },
      connections: [workspaceAccount, organizationAccount],
    });
    expect(decidePlacement(localFirst)).toMatchObject({
      kind: "run",
      connectionId: "codex-local",
    });
    expect(
      decidePlacement({
        ...localFirst,
        settings: {
          ...localFirst.settings,
          providers: {
            codex: { inferenceSource: "organization", useOrganizationAccounts: true, enabled: true },
          },
        },
      }),
    ).toMatchObject({ kind: "run", connectionId: "codex-org" });
    expect(
      decidePlacement({
        ...localFirst,
        settings: {
          ...localFirst.settings,
          providers: {
            codex: { inferenceSource: "workspace", useOrganizationAccounts: false, enabled: true },
          },
        },
      }),
    ).toMatchObject({ kind: "run", connectionId: "codex-local" });
  });

  test("one canonical connection keeps distinct model policy for both source memberships", () => {
    const bothPools = connection("codex-shared", "codex", {
      assignmentPolicies: [
        {
          workspaceId: "ws-team",
          inferencePool: "workspace",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: true,
        },
        {
          workspaceId: "ws-team",
          inferencePool: "organization",
          allowedModelIds: ["codex/b"],
          allocatorEnabled: true,
        },
      ],
    });
    const base = input({
      connections: [bothPools],
      session: { preferredModelId: "codex/a" },
      settings: {
        providers: { codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true } },
      },
    });
    expect(decidePlacement(base)).toMatchObject({ kind: "run", connectionId: "codex-shared" });
    expect(
      decidePlacement({
        ...base,
        session: { ...base.session, preferredModelId: "codex/b" },
        settings: {
          ...base.settings,
          providers: {
            codex: { inferenceSource: "workspace", useOrganizationAccounts: false, enabled: true },
          },
        },
      }),
    ).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    expect(
      decidePlacement({
        ...base,
        session: { ...base.session, preferredModelId: "codex/b" },
        settings: {
          ...base.settings,
          providers: {
            codex: { inferenceSource: "organization", useOrganizationAccounts: true, enabled: true },
          },
        },
      }),
    ).toMatchObject({ kind: "run", connectionId: "codex-shared", modelId: "codex/b" });
  });

  test("SUB-SET-06: a provider switched off for the workspace serves none of its models and is never a failover target", () => {
    const off = { codex: { useOrganizationAccounts: true, enabled: false } };
    expect(decidePlacement(input({ settings: { providers: off, fallbackOrder: {} } }))).toEqual({
      kind: "wait",
      reason: "model_not_allowed",
      earliestResetAt: null,
    });
    const claudeOff = { claude: { useOrganizationAccounts: true, enabled: false } };
    const exhausted = input({
      settings: { providers: claudeOff },
      connections: [
        connection("codex-1", "codex", { quota: quota({ exhaustedUntil: NOW + 60_000 }) }),
        connection("claude-1", "claude"),
      ],
    });
    expect(failoverCandidateModels(exhausted)).toEqual(["codex/a", "claude/a"]);
    expect(modelPermitted(exhausted, "claude/a")).toBe(false);
    expect(decidePlacement(exhausted)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: NOW + 60_000,
    });
  });

  test("SUB-SET-06: without organization accounts only connections the workspace manages serve it", () => {
    const local = connection("codex-local", "codex", {
      ownership: {
        kind: "shared",
        scope: { kind: "workspaces", workspaceIds: ["ws-team"], allowPersonalWorkspaces: false },
        managedByWorkspaceId: "ws-team",
      },
      quota: null,
    });
    const world = input({
      settings: { providers: { codex: { useOrganizationAccounts: false, enabled: true } } },
      connections: [connection("codex-org", "codex"), local],
    });
    expect(authorizationIneligibility(world, world.connections[0]!)).toEqual([
      "organization_accounts_off",
    ]);
    expect(decidePlacement(world)).toMatchObject({ kind: "run", connectionId: "codex-local" });
  });
});

describe("eligibility", () => {
  test("SUB-ELIG-05: a personal connection needs the owner's own private work and frozen personal authority for that provider", () => {
    const own = personal("codex-mine", "codex");
    const privateWork = input({
      session: { visibility: "private" },
      connections: [own],
      personalFallbackOptIn: true,
    });
    expect(authorizationIneligibility(privateWork, own)).toEqual(["personal_authority_missing"]);
    expect(decidePlacement(privateWork)).toMatchObject({ kind: "wait" });
    const withAuthority = input({
      session: {
        visibility: "private",
        personalAuthority: [{ provider: "codex", ownerMembershipId: "member-a" }],
      },
      connections: [own],
      personalFallbackOptIn: true,
    });
    expect(decidePlacement(withAuthority)).toMatchObject({
      kind: "run",
      connectionId: "codex-mine",
      personal: true,
    });
    // Authority for another provider does not count.
    const otherProvider = input({
      session: {
        visibility: "private",
        personalAuthority: [{ provider: "claude", ownerMembershipId: "member-a" }],
      },
      connections: [own],
      personalFallbackOptIn: true,
    });
    expect(authorizationIneligibility(otherProvider, own)).toEqual(["personal_authority_missing"]);
  });

  test("SUB-ELIG-04: health and allocator eligibility are separate serviceability reasons, not authorization", () => {
    const world = input({});
    const reasons = connectionIneligibility(
      world,
      connection("codex-x", "codex", { health: "needs_reconnect", allocatorEnabled: false }),
      "codex/a",
    );
    expect(reasons).toEqual(["unhealthy", "allocator_disabled"]);
    expect(reasons.some(isAuthorizationIneligibility)).toBe(false);
  });

  test("SUB-ELIG-03: entitlement exclusions, access policy and per-model cooldowns filter automatically", () => {
    const world = input({});
    const reasonsFor = (patch: Partial<SubscriptionConnection>) =>
      connectionIneligibility(world, connection("codex-x", "codex", patch), "codex/a");
    expect(reasonsFor({ excludedModelIds: ["codex/a"] })).toEqual(["model_not_entitled"]);
    expect(reasonsFor({ entitledModelIds: ["codex/b"] })).toEqual(["model_not_entitled"]);
    expect(reasonsFor({ allowedModelIds: ["codex/b"] })).toEqual([
      "model_not_allowed_by_connection",
    ]);
    expect(reasonsFor({ quota: quota({ modelCooldowns: { "codex/a": NOW + 1 } }) })).toEqual([
      "model_cooling_down",
    ]);
    expect(reasonsFor({ quota: quota({ modelCooldowns: { "codex/b": NOW + 1 } }) })).toEqual([]);
  });
});

describe("shared quota model", () => {
  test("SUB-ELIG-06: missing or unknown quota stays unknown; only observations make capacity known or exhausted", () => {
    expect(quotaCapacity(null, NOW)).toEqual({ kind: "unknown" });
    expect(quotaCapacity(quota({ windows: [] }), NOW)).toEqual({ kind: "unknown" });
    expect(
      quotaCapacity(
        quota({ windows: [{ id: "w", usedPercent: null, resetsAt: null, status: "unknown" }] }),
        NOW,
      ),
    ).toEqual({ kind: "unknown" });
    expect(quotaCapacity(quota(), NOW)).toEqual({ kind: "available" });
    expect(
      quotaCapacity(
        quota({
          windows: [
            { id: "short", usedPercent: 100, resetsAt: NOW + 10, status: "exhausted" },
            { id: "long", usedPercent: 100, resetsAt: NOW + 50, status: "exhausted" },
          ],
        }),
        NOW,
      ),
    ).toEqual({ kind: "exhausted", resetsAt: NOW + 50 });
    expect(
      quotaCapacity(
        quota({ windows: [{ id: "w", usedPercent: 100, resetsAt: null, status: "exhausted" }] }),
        NOW,
      ),
    ).toEqual({ kind: "exhausted", resetsAt: null });
    // A passed quota deadline is an observed reset; a passed rate limit says nothing.
    expect(
      quotaCapacity(quota({ windows: [], exhaustedUntil: NOW - 1, exhaustedKind: "quota" }), NOW),
    ).toEqual({ kind: "available" });
    expect(
      quotaCapacity(
        quota({ windows: [], exhaustedUntil: NOW - 1, exhaustedKind: "rate_limit" }),
        NOW,
      ),
    ).toEqual({ kind: "unknown" });
  });

  test("SUB-ELIG-06: an observation from an older credential generation never replaces the current quota", () => {
    const current = quota({ observedAt: NOW - 100, observedRefreshGeneration: 2 });
    const stale = quota({
      exhaustedUntil: NOW + 60_000,
      exhaustedKind: "quota",
      observedAt: NOW,
      observedRefreshGeneration: 1,
      source: "refusal",
    });
    expect(quotaObservationApplies({ refreshGeneration: 2 }, stale)).toBe(false);
    expect(applyQuotaObservation({ refreshGeneration: 2, quota: current }, stale)).toBe(current);
    const fresh = { ...stale, observedRefreshGeneration: 2 };
    expect(applyQuotaObservation({ refreshGeneration: 2, quota: current }, fresh)).toEqual(fresh);
    const older = { ...fresh, observedAt: NOW - 1_000 };
    expect(applyQuotaObservation({ refreshGeneration: 2, quota: current }, older)).toBe(current);
  });
});

describe("cache coldness", () => {
  test("SUB-STICK-04: exact TTLs are exact and unmeasured idle cut-offs default to an hour", () => {
    expect(cacheLifetimeMs({ kind: "exact_ttl", ttlMs: 300_000 })).toBe(300_000);
    expect(cacheLifetimeMs({ kind: "measured_idle_cutoff", cutoffMs: 900_000 })).toBe(900_000);
    expect(cacheLifetimeMs({ kind: "measured_idle_cutoff", cutoffMs: null })).toBe(
      DEFAULT_IDLE_CUTOFF_MS,
    );
    const binding = { lastModelCallAt: NOW - 300_000 };
    expect(isCacheWarm(binding, { kind: "exact_ttl", ttlMs: 300_000 }, NOW)).toBe(true);
    expect(isCacheWarm(binding, { kind: "exact_ttl", ttlMs: 299_999 }, NOW)).toBe(false);
  });

  test("SUB-STICK-02, SUB-STICK-03: a warm session stays on its account even when the primary could take it", () => {
    const world = input({
      settings: { rotation: { codex: { mode: "primary_first", primaryConnectionId: "codex-1" } } },
      connections: [connection("codex-1", "codex"), connection("codex-2", "codex")],
      session: {
        binding: {
          connectionId: "codex-2",
          provider: "codex",
          modelId: "codex/a",
          choice: "automatic",
          lastModelCallAt: NOW - 30 * 60_000,
        },
      },
    });
    expect(decidePlacement(world)).toMatchObject({ connectionId: "codex-2", switch: "sticky" });
    const cold = {
      ...world,
      session: {
        ...world.session,
        binding: { ...world.session.binding!, lastModelCallAt: NOW - 2 * 60 * 60_000 },
      },
    };
    expect(decidePlacement(cold)).toMatchObject({
      connectionId: "codex-1",
      switch: "reselected_cold",
    });
  });
});

describe("placement", () => {
  test("SUB-SEL-04, SUB-STICK-06: an explicit choice waits for its account, including a model cooldown, and is kept at re-selection points", () => {
    const world = input({
      connections: [
        connection("codex-1", "codex", {
          quota: quota({ modelCooldowns: { "codex/a": NOW + 45_000 } }),
        }),
        connection("codex-2", "codex"),
      ],
      session: {
        reselectionPoints: ["compaction_completed"],
        binding: {
          connectionId: "codex-1",
          provider: "codex",
          modelId: "codex/a",
          choice: "explicit",
          lastModelCallAt: NOW - 10 * 60 * 60_000,
        },
      },
    });
    expect(decidePlacement(world)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: NOW + 45_000,
    });
    expect(decidePlacement({ ...world, now: NOW + 45_000 })).toMatchObject({
      kind: "run",
      connectionId: "codex-1",
      switch: "pinned",
    });
  });

  test("SUB-FAIL-09: a compaction provider lock keeps failover inside that provider", () => {
    const world = input({
      session: { compactionProviderLock: "codex" },
      connections: [
        connection("codex-1", "codex", { quota: quota({ exhaustedUntil: NOW + 60_000 }) }),
        connection("claude-1", "claude"),
      ],
    });
    expect(modelPermitted(world, "claude/a")).toBe(false);
    expect(decidePlacement(world)).toMatchObject({ kind: "wait", earliestResetAt: NOW + 60_000 });
    // A locked session asking for another provider's model waits, explained.
    expect(
      decidePlacement({
        ...world,
        session: { ...world.session, preferredModelId: "claude/a" },
      }),
    ).toEqual({ kind: "wait", reason: "compaction_provider_locked", earliestResetAt: null });
  });

  test("SUB-FAIL-05: 'only this model' excludes even same-provider fallback models", () => {
    const world = input({
      settings: { fallbackOrder: { "codex/a": ["codex/b", "claude/a"] } },
      session: { onlyThisModel: true },
    });
    expect(failoverCandidateModels(world)).toEqual(["codex/a"]);
    expect(
      failoverCandidateModels({ ...world, session: { ...world.session, onlyThisModel: false } }),
    ).toEqual(["codex/a", "codex/b", "claude/a"]);
  });

  test("SUB-FAIL-03: reasoning levels map to the nearest supported level (D-16)", () => {
    const claude = { reasoningLevels: ["low", "medium", "high", "xhigh", "max"] };
    expect(mapReasoningLevel("high", claude, { reasoningLevels: ["low", "high"] })).toBe("high");
    expect(mapReasoningLevel("xhigh", claude, { reasoningLevels: ["low", "high"] })).toBe("high");
    expect(mapReasoningLevel("medium", claude, { reasoningLevels: ["low", "max"] })).toBe("low");
    expect(mapReasoningLevel("max", claude, { reasoningLevels: ["low", "medium", "high"] })).toBe(
      "high",
    );
    // An unlisted level maps to the middle, the lower middle of two (D-16).
    expect(mapReasoningLevel("unknown", claude, { reasoningLevels: ["low", "high"] })).toBe("low");
    expect(
      mapReasoningLevel("unknown", claude, { reasoningLevels: ["low", "medium", "high"] }),
    ).toBe("medium");
    expect(
      mapReasoningLevel("high", undefined, { reasoningLevels: ["low", "medium", "max"] }),
    ).toBe("medium");
  });

  test("SUB-SEL-03: spread gives each session a stable home that an unrelated new account does not move", () => {
    const pool = ["codex-1", "codex-2", "codex-3"].map((id) => connection(id, "codex"));
    const homes = new Map<string, number>();
    let moved = 0;
    for (let index = 0; index < 3_000; index += 1) {
      const world = input({ session: { id: "session-" + index }, connections: pool });
      const home = rankConnections(world, pool)[0]!.id;
      homes.set(home, (homes.get(home) ?? 0) + 1);
      const grown = [...pool, connection("codex-4", "codex")];
      const after = rankConnections({ ...world, connections: grown }, grown)[0]!.id;
      if (after !== home && after !== "codex-4") moved += 1;
    }
    expect(moved).toBe(0);
    for (const count of homes.values()) expect(count).toBeGreaterThan(900);
    expect(spreadHash("session", "connection")).toBe(spreadHash("session", "connection"));
  });
});

describe("package boundary", () => {
  test("the policy package imports nothing but its own modules and uses no clock or randomness", () => {
    const source = join(import.meta.dir, "..", "src");
    for (const file of readdirSync(source)) {
      const text = readFileSync(join(source, file), "utf8");
      for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
        expect({ file, module: match[1] }).toEqual({
          file,
          module: expect.stringMatching(/^\.\//),
        });
      }
      expect(text).not.toMatch(/\bimport\(|\brequire\(|\bfetch\(|Date\.now|Math\.random/);
    }
  });

  test("placement never imports the reference model, and the reference model imports nothing", () => {
    const source = join(import.meta.dir, "..", "src");
    for (const file of readdirSync(source)) {
      const text = readFileSync(join(source, file), "utf8");
      const imports = [...text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map(
        (match) => match[1]!,
      );
      if (file === "reference-model.ts") expect(imports).toEqual([]);
      else if (!file.startsWith("reference")) {
        expect(imports.filter((module) => module.startsWith("./reference"))).toEqual([]);
      }
    }
    expect(readFileSync(join(source, "index.ts"), "utf8")).not.toContain("reference");
  });
});

describe("explicit choices, personal fallback and explained waits", () => {
  const explicit = (connectionId: string) => ({
    connectionId,
    provider: "codex",
    modelId: "codex/a",
    choice: "explicit" as const,
    lastModelCallAt: NOW - 1_000,
  });

  test("SUB-ACCESS-06, SUB-SEL-04: an explicit choice that can never serve says so; one that can recover waits for it (D-24)", () => {
    const outOfScope = connection("codex-elsewhere", "codex", {
      ownership: {
        kind: "shared",
        scope: { kind: "workspaces", workspaceIds: ["ws-other"], allowPersonalWorkspaces: false },
        managedByWorkspaceId: null,
      },
    });
    for (const world of [
      input({ session: { binding: explicit("codex-gone") } }),
      input({ connections: [outOfScope], session: { binding: explicit(outOfScope.id) } }),
      input({
        connections: [connection("claude-1", "claude")],
        session: { binding: { ...explicit("claude-1"), provider: "claude" } },
      }),
      input({
        connections: [connection("codex-1", "codex", { allowedModelIds: ["codex/b"] })],
        session: { binding: explicit("codex-1") },
      }),
    ]) {
      expect(decidePlacement(world)).toEqual({
        kind: "wait",
        reason: "pinned_account_ineligible",
        earliestResetAt: null,
      });
    }
    const reconnect = input({
      connections: [connection("codex-1", "codex", { health: "needs_reconnect" })],
      session: { binding: explicit("codex-1") },
    });
    expect(decidePlacement(reconnect)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: null,
    });
  });

  test("SUB-STICK-02, SUB-STICK-03, SUB-STICK-07: a warm personal account is kept in its owner's private session after fallback is turned off (D-27), left at the next cold re-selection, and left when the session is shared or personal connections are disabled (SUB-OWN-05)", () => {
    const mine = personal("codex-mine", "codex");
    const base = {
      connections: [connection("codex-org", "codex"), mine],
      session: {
        visibility: "private" as const,
        personalAuthority: [{ provider: "codex", ownerMembershipId: "member-a" }],
        binding: {
          connectionId: "codex-mine",
          provider: "codex",
          modelId: "codex/a",
          choice: "automatic" as const,
          lastModelCallAt: NOW - 1_000,
        },
      },
    };
    expect(decidePlacement(input({ ...base, personalFallbackOptIn: false }))).toMatchObject({
      connectionId: "codex-mine",
      switch: "sticky",
    });
    expect(
      decidePlacement(
        input({
          ...base,
          personalFallbackOptIn: false,
          settings: { personalFallbackAllowed: false },
        }),
      ),
    ).toMatchObject({ connectionId: "codex-mine", switch: "sticky" });
    // The organization switch alone, with the owner still opted in.
    expect(
      decidePlacement(
        input({
          ...base,
          personalFallbackOptIn: true,
          settings: { personalFallbackAllowed: false },
        }),
      ),
    ).toMatchObject({ connectionId: "codex-mine", switch: "sticky" });
    // Disabling personal connections is a forced move (SUB-OWN-05), unlike D-27.
    expect(
      decidePlacement(
        input({
          ...base,
          personalFallbackOptIn: true,
          settings: { personalConnectionsAllowed: false },
        }),
      ),
    ).toMatchObject({ connectionId: "codex-org", personal: false });
    const cold = {
      ...base.session,
      binding: { ...base.session.binding, lastModelCallAt: NOW - 2 * DEFAULT_IDLE_CUTOFF_MS },
    };
    expect(
      decidePlacement(input({ ...base, session: cold, personalFallbackOptIn: false })),
    ).toMatchObject({ connectionId: "codex-org", personal: false });
    expect(
      decidePlacement(input({ ...base, session: { ...base.session, visibility: "shared" } })),
    ).toMatchObject({ connectionId: "codex-org", personal: false });
  });

  test("SUB-FAIL-09: a wait caused by the compaction lock says so", () => {
    const world = input({
      session: { compactionProviderLock: "codex" },
      connections: [
        connection("codex-1", "codex", { quota: quota({ exhaustedUntil: NOW + 60_000 }) }),
        connection("claude-1", "claude"),
      ],
    });
    expect(decidePlacement(world)).toEqual({
      kind: "wait",
      reason: "compaction_provider_locked",
      earliestResetAt: NOW + 60_000,
    });
    expect(decidePlacement({ ...world, connections: [world.connections[0]!] })).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });
  });

  test("SUB-SET-06, SUB-ELIG-02: a preferred model whose provider is switched off moves to an allowed fallback, like a restricted model (D-17, D-26)", () => {
    const world = input({
      settings: { providers: { codex: { useOrganizationAccounts: true, enabled: false } } },
      connections: [connection("claude-1", "claude")],
    });
    expect(failoverCandidateModels(world)).toEqual(["codex/a", "claude/a"]);
    expect(decidePlacement(world)).toMatchObject({
      kind: "run",
      connectionId: "claude-1",
      modelId: "claude/a",
      switch: "initial",
    });
    expect(
      decidePlacement({ ...world, settings: { ...world.settings, crossProviderFailover: false } }),
    ).toEqual({ kind: "wait", reason: "model_not_allowed", earliestResetAt: null });
  });

  test("SUB-ELIG-02: an unknown preferred model is never placed and waits on the restriction", () => {
    expect(decidePlacement(input({ session: { preferredModelId: "codex/unknown" } }))).toEqual({
      kind: "wait",
      reason: "model_not_allowed",
      earliestResetAt: null,
    });
  });
});

describe("quota freshness and observations", () => {
  test("SUB-ELIG-06: a stale reading counts as unknown, so it no longer outranks unknown quota", () => {
    const weekOld = quota({ observedAt: NOW - 7 * 24 * 3_600_000 });
    expect(quotaCapacity(weekOld, NOW)).toEqual({ kind: "available" });
    expect(quotaCapacity(weekOld, NOW, 3_600_000)).toEqual({ kind: "unknown" });
    expect(quotaCapacity(quota({ observedAt: null }), NOW, 3_600_000)).toEqual({ kind: "unknown" });
    // Observed exhaustion still stands until its reset.
    expect(
      quotaCapacity(
        quota({
          observedAt: NOW - 7 * 24 * 3_600_000,
          windows: [{ id: "w", usedPercent: 100, resetsAt: NOW + 10, status: "exhausted" }],
        }),
        NOW,
        3_600_000,
      ),
    ).toEqual({ kind: "exhausted", resetsAt: NOW + 10 });
    const pool = [
      connection("codex-1", "codex", { quota: weekOld }),
      connection("codex-2", "codex", { quota: null }),
    ];
    const ranked = (staleAfter: number | undefined) =>
      rankConnections(
        {
          ...input({ connections: pool }),
          ...(staleAfter === undefined ? {} : { quotaStaleAfterMs: { codex: staleAfter } }),
        },
        pool,
      ).map((candidate) => candidate.id);
    expect(ranked(undefined)[0]).toBe("codex-1");
    // With the bound both are unknown: the spread hash decides.
    expect(new Set(ranked(3_600_000))).toEqual(new Set(["codex-1", "codex-2"]));
  });

  test("SUB-ELIG-06: a later reading never clears a running model cooldown or exhaustion deadline, and an undated reading never replaces a dated one", () => {
    const current = quota({
      observedAt: NOW - 1_000,
      modelCooldowns: { "claude/a": NOW + 60_000 },
      exhaustedUntil: NOW + 30_000,
      exhaustedKind: "rate_limit",
    });
    const usageRead = quota({ observedAt: NOW, source: "usage_endpoint" });
    const merged = applyQuotaObservation({ refreshGeneration: 1, quota: current }, usageRead)!;
    expect(merged.modelCooldowns).toEqual({ "claude/a": NOW + 60_000 });
    expect(merged.exhaustedUntil).toBe(NOW + 30_000);
    expect(merged.exhaustedKind).toBe("rate_limit");
    expect(merged.windows).toEqual(usageRead.windows);
    expect(
      applyQuotaObservation({ refreshGeneration: 1, quota: current }, quota({ observedAt: null })),
    ).toBe(current);
    // A deadline or cooldown that ended before the new reading is not kept.
    const ended = quota({
      observedAt: NOW - 120_000,
      modelCooldowns: { "claude/a": NOW - 60_000 },
      exhaustedUntil: NOW - 60_000,
      exhaustedKind: "quota",
    });
    const later = applyQuotaObservation(
      { refreshGeneration: 1, quota: ended },
      quota({ observedAt: NOW, windows: [] }),
    )!;
    expect(later.modelCooldowns).toEqual({});
    expect(later.exhaustedUntil).toBeNull();
    expect(quotaCapacity(later, NOW)).toEqual({ kind: "unknown" });
  });
});

describe("cache lifetime and settings fields", () => {
  test("SUB-STICK-04: the exact cache lifetime sent with the latest request decides warmth", () => {
    const binding = { lastModelCallAt: NOW - 30 * 60_000, cacheTtlMs: 60 * 60_000 };
    expect(isCacheWarm(binding, { kind: "exact_ttl", ttlMs: 300_000 }, NOW)).toBe(true);
    expect(isCacheWarm({ ...binding, cacheTtlMs: 300_000 }, undefined, NOW)).toBe(false);
  });

  test("SUB-SET-02: a workspace can override one provider switch and inherit the other (D-25)", () => {
    const resolved = effectiveSettings(
      {
        organization: {
          ...SETTINGS,
          providers: { codex: { useOrganizationAccounts: false, enabled: true } },
        },
        locked: [],
        workspaces: { "ws-team": { providers: { codex: { enabled: false } } } },
      },
      "ws-team",
    );
    expect(resolved.values.providers.codex).toEqual({
      inferenceSource: "workspace",
      useOrganizationAccounts: false,
      enabled: false,
    });
  });
});
