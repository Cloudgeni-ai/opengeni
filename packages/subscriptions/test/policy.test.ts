import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyQuotaObservation,
  authorizationIneligibility,
  bindingStickiness,
  cacheLifetimeMs,
  connectionIneligibility,
  decidePlacement,
  declaredCacheLifetimeMs,
  DEFAULT_IDLE_CUTOFF_MS,
  effectiveSettings,
  failoverCandidateModels,
  isAuthorizationIneligibility,
  isCacheWarm,
  mapReasoningLevel,
  modelPermitted,
  quotaCapacity,
  quotaBlockClaim,
  quotaObservationApplies,
  rankConnections,
  spreadHash,
  storedQuotaDocument,
  type Ineligibility,
  type PlacementInput,
  type SubscriptionConnection,
  type SubscriptionQuota,
  type SubscriptionSettingValues,
} from "../src/index";
import { checkPlacementDecision, toReferenceWorld } from "../src/reference";
import {
  checkDecision as checkReferenceDecision,
  decide as decideReference,
} from "../src/reference-model";

const NOW = 10_000_000;

describe("exact personal authority in shared chats", () => {
  function sharedChoice(): PlacementInput {
    const state = input({
      connections: [personal("own", "codex"), personal("other", "codex")],
      personalFallbackOptIn: true,
      session: {
        ownerMembershipId: "chat-owner",
        personalAuthority: [
          {
            provider: "codex",
            ownerMembershipId: "member-a",
            sharedSessionChoice: { sessionId: "session-1", connectionId: "own" },
          },
        ],
        binding: {
          provider: "codex",
          connectionId: "own",
          modelId: "codex/a",
          choice: "explicit",
          lastModelCallAt: NOW,
        },
      },
    });
    state.people = [
      ...state.people,
      { membershipId: "chat-owner", active: true, personalFallbackOptIn: true },
    ];
    return state;
  }

  test("a participating noncreator's explicit account is eligible, not their other account", () => {
    const state = sharedChoice();
    const result = decidePlacement(state);
    expect(result).toMatchObject({ kind: "run", connectionId: "own" });
    expect(authorizationIneligibility(state, state.connections[1]!)).toContain(
      "personal_not_owners_work",
    );
    expect(checkPlacementDecision(state, result)).toEqual([]);
  });

  test("automatic selection, foreign sessions, absent authority, policy off and inactive owners refuse", () => {
    for (const mutate of [
      (state: PlacementInput) => {
        state.session.binding = null;
      },
      (state: PlacementInput) => {
        state.session.id = "other-session";
      },
      (state: PlacementInput) => {
        state.session.personalAuthority = [];
      },
      (state: PlacementInput) => {
        state.settings.personalConnectionsAllowed = false;
      },
      (state: PlacementInput) => {
        state.people = state.people.map((person) => ({ ...person, active: false }));
      },
      (state: PlacementInput) => {
        state.session.ownerMembershipId = null;
      },
    ]) {
      const state = sharedChoice();
      mutate(state);
      const result = decidePlacement(state);
      expect(result.kind).toBe("wait");
      expect(checkPlacementDecision(state, result)).toEqual([]);
    }
  });

  test("legacy private-work authority never becomes shared-chat consent", () => {
    const state = sharedChoice();
    state.session.ownerMembershipId = "member-a";
    state.session.personalAuthority = [{ provider: "codex", ownerMembershipId: "member-a" }];
    expect(decidePlacement(state).kind).toBe("wait");
    state.session.visibility = "private";
    expect(decidePlacement(state)).toMatchObject({ kind: "run", connectionId: "own" });
  });
});

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
        providers: {
          codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true },
        },
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
            codex: {
              inferenceSource: "organization",
              useOrganizationAccounts: true,
              enabled: true,
            },
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
        providers: {
          codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true },
        },
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
            codex: {
              inferenceSource: "organization",
              useOrganizationAccounts: true,
              enabled: true,
            },
          },
        },
      }),
    ).toMatchObject({ kind: "run", connectionId: "codex-shared", modelId: "codex/b" });
  });

  test("automatic mode never combines model access and allocator permission across assignments", () => {
    const mixedPolicies = connection("codex-mixed", "codex", {
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
          allocatorEnabled: false,
        },
      ],
    });
    expect(
      decidePlacement(
        input({
          connections: [mixedPolicies],
          session: { preferredModelId: "codex/b" },
          settings: {
            providers: {
              codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true },
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
  });

  test("an empty shared assignment list fails closed instead of using the legacy pool fallback", () => {
    const unassigned = connection("codex-unassigned", "codex", {
      ownership: {
        kind: "shared",
        scope: { kind: "organization" },
        managedByWorkspaceId: null,
      },
      assignmentPolicies: [],
    });
    const placement = input({ connections: [unassigned] });
    expect(authorizationIneligibility(placement, unassigned)).toContain(
      "inference_source_excludes_connection",
    );
    expect(decidePlacement(placement)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });
  });

  test("ownerless service sessions can use shared scope but never person or personal pools", () => {
    const ownerless = input({
      session: {
        ownerMembershipId: null,
        visibility: "shared",
        personalAuthority: [{ provider: "codex", ownerMembershipId: "member-a" }],
      },
      personalFallbackOptIn: true,
      settings: { personalFallbackAllowed: true },
      connections: [
        connection("org", "codex"),
        connection("person-scoped", "codex", {
          ownership: {
            kind: "shared",
            scope: { kind: "people", membershipIds: ["member-a"] },
            managedByWorkspaceId: null,
          },
        }),
        personal("personal", "codex"),
      ],
    });

    const sharedDecision = decidePlacement(ownerless);
    expect(sharedDecision).toMatchObject({
      kind: "run",
      connectionId: "org",
    });
    expect(checkPlacementDecision(ownerless, sharedDecision)).toEqual([]);
    const sharedReference = toReferenceWorld(ownerless);
    expect(sharedReference.world.sessions[0]?.ownerId).toBeNull();
    const sharedReferenceDecision = decideReference(
      sharedReference.world,
      sharedReference.sessionId,
      NOW,
    );
    expect(sharedReferenceDecision.kind).toBe("run");
    expect(
      checkReferenceDecision(
        sharedReference.world,
        sharedReference.sessionId,
        NOW,
        sharedReferenceDecision,
      ),
    ).toEqual([]);

    const noShared = input({
      session: { ownerMembershipId: null, visibility: "shared" },
      connections: [
        connection("person-scoped", "codex", {
          ownership: {
            kind: "shared",
            scope: { kind: "people", membershipIds: ["member-a"] },
            managedByWorkspaceId: null,
          },
        }),
        personal("personal", "codex"),
      ],
    });
    const restrictedDecision = decidePlacement(noShared);
    expect(restrictedDecision).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });
    expect(checkPlacementDecision(noShared, restrictedDecision)).toEqual([]);
    const restrictedReference = toReferenceWorld(noShared);
    expect(restrictedReference.world.sessions[0]?.ownerId).toBeNull();
    const restrictedReferenceDecision = decideReference(
      restrictedReference.world,
      restrictedReference.sessionId,
      NOW,
    );
    expect(restrictedReferenceDecision.kind).toBe("wait");
    expect(
      checkReferenceDecision(
        restrictedReference.world,
        restrictedReference.sessionId,
        NOW,
        restrictedReferenceDecision,
      ),
    ).toEqual([]);
  });

  test("an explicit automatic source overrides a conflicting compatibility boolean", () => {
    const organizationAccount = connection("codex-org", "codex", {
      ownership: {
        kind: "shared",
        scope: { kind: "organization" },
        managedByWorkspaceId: null,
      },
      allocatorEnabled: true,
    });
    expect(
      decidePlacement(
        input({
          connections: [organizationAccount],
          settings: {
            providers: {
              codex: {
                inferenceSource: "automatic",
                useOrganizationAccounts: false,
                enabled: true,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "run", connectionId: "codex-org" });
  });

  test("a legacy workspace opt-out overrides an inherited automatic organization source", () => {
    const organizationOnly = effectiveSettings(
      {
        organization: {
          ...SETTINGS,
          providers: {
            codex: { inferenceSource: "automatic", useOrganizationAccounts: false, enabled: true },
          },
        },
        locked: [],
        workspaces: {},
      },
      "ws-team",
    );
    expect(organizationOnly.values.providers.codex).toMatchObject({
      inferenceSource: "automatic",
      useOrganizationAccounts: true,
    });

    const resolved = effectiveSettings(
      {
        organization: {
          ...SETTINGS,
          providers: {
            codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true },
          },
        },
        locked: [],
        workspaces: {
          "ws-team": { providers: { codex: { useOrganizationAccounts: false } } },
        },
      },
      "ws-team",
    );
    expect(resolved.values.providers.codex).toMatchObject({
      inferenceSource: "workspace",
      useOrganizationAccounts: false,
    });
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

describe("cache-aware stickiness: why a binding keeps or leaves its account", () => {
  const warmBinding = {
    connectionId: "codex-2",
    provider: "codex",
    modelId: "codex/a",
    choice: "automatic" as const,
    lastModelCallAt: NOW - 60_000,
  };
  // codex-1 is the primary, so normal selection would leave codex-2.
  const sticky = (
    patch: {
      bound?: Partial<SubscriptionConnection> | null;
      session?: Partial<PlacementInput["session"]>;
      settings?: Partial<SubscriptionSettingValues>;
      workspace?: Partial<PlacementInput["workspace"]>;
      now?: number;
    } = {},
  ) =>
    input({
      ...(patch.now === undefined ? {} : { now: patch.now }),
      ...(patch.workspace === undefined ? {} : { workspace: patch.workspace }),
      settings: {
        rotation: { codex: { mode: "primary_first", primaryConnectionId: "codex-1" } },
        ...patch.settings,
      },
      connections: [
        connection("codex-1", "codex"),
        ...(patch.bound === null ? [] : [connection("codex-2", "codex", patch.bound ?? {})]),
      ],
      session: { binding: warmBinding, ...patch.session },
    });

  test("SUB-STICK-02: a warm, servable automatic binding is kept and placement stays sticky", () => {
    const world = sticky();
    expect(bindingStickiness(world)).toEqual({
      kind: "keep",
      connectionId: "codex-2",
      modelId: "codex/a",
    });
    expect(decidePlacement(world)).toMatchObject({ connectionId: "codex-2", switch: "sticky" });
  });

  test("SUB-STICK-03: each forced reason re-selects even while the cache is warm", () => {
    const cases: Array<{
      name: string;
      world: PlacementInput;
      reason: string;
      ineligibility?: Ineligibility[];
    }> = [
      {
        name: "exhausted",
        world: sticky({ bound: { quota: quota({ exhaustedUntil: NOW + 60_000 }) } }),
        reason: "account_ineligible",
        ineligibility: ["exhausted"],
      },
      {
        name: "rate limited",
        world: sticky({
          bound: { quota: quota({ exhaustedUntil: NOW + 30_000, exhaustedKind: "rate_limit" }) },
        }),
        reason: "account_ineligible",
        ineligibility: ["exhausted"],
      },
      {
        name: "model rate limited",
        world: sticky({ bound: { quota: quota({ modelCooldowns: { "codex/a": NOW + 30_000 } }) } }),
        reason: "account_ineligible",
        ineligibility: ["model_cooling_down"],
      },
      {
        name: "quarantined",
        world: sticky({ bound: { health: "error" } }),
        reason: "account_ineligible",
        ineligibility: ["unhealthy"],
      },
      {
        name: "needs a new sign-in",
        world: sticky({ bound: { health: "needs_reconnect" } }),
        reason: "account_ineligible",
        ineligibility: ["unhealthy"],
      },
      {
        name: "switched off for automatic selection",
        world: sticky({ bound: { allocatorEnabled: false } }),
        reason: "account_ineligible",
        ineligibility: ["allocator_disabled"],
      },
      {
        name: "out of scope for the session's workspace",
        world: sticky({
          bound: {
            ownership: {
              kind: "shared",
              scope: {
                kind: "workspaces",
                workspaceIds: ["ws-other"],
                allowPersonalWorkspaces: false,
              },
              managedByWorkspaceId: null,
            },
          },
        }),
        reason: "account_ineligible",
        ineligibility: ["out_of_scope"],
      },
      {
        name: "disconnected or removed",
        world: sticky({ bound: null }),
        reason: "account_unavailable",
      },
      {
        name: "its model no longer allowed in the workspace",
        world: sticky({ workspace: { allowedModelIds: ["codex/b"] } }),
        reason: "model_not_permitted",
      },
      {
        name: "its provider switched off for the workspace",
        world: sticky({
          settings: { providers: { codex: { useOrganizationAccounts: true, enabled: false } } },
        }),
        reason: "model_not_permitted",
      },
      {
        name: "a compaction mode tied to another provider",
        world: sticky({ session: { compactionProviderLock: "claude" } }),
        reason: "model_not_permitted",
      },
      {
        name: "paid credits while another account has included allowance",
        world: sticky({
          bound: {
            extraCreditsEnabled: true,
            quota: quota({
              windows: [
                { id: "weekly", usedPercent: 100, resetsAt: NOW + 3_600_000, status: "exhausted" },
              ],
            }),
          },
        }),
        reason: "extra_credits",
      },
    ];
    for (const entry of cases) {
      const verdict = bindingStickiness(entry.world);
      expect({ name: entry.name, verdict }).toMatchObject({
        name: entry.name,
        verdict: { kind: "reselect", reason: entry.reason },
      });
      if (entry.ineligibility && verdict.kind === "reselect")
        expect({ name: entry.name, ineligibility: verdict.ineligibility }).toEqual({
          name: entry.name,
          ineligibility: entry.ineligibility,
        });
      const decision = decidePlacement(entry.world);
      // Forced: never back onto the bound account and model.
      expect({
        name: entry.name,
        kept:
          decision.kind === "run" &&
          decision.connectionId === "codex-2" &&
          decision.modelId === "codex/a",
      }).toEqual({ name: entry.name, kept: false });
    }
  });

  test("SUB-STICK-05, SUB-STICK-04: a re-selection point or a cold cache re-runs normal selection", () => {
    const compacted = sticky({ session: { reselectionPoints: ["compaction_completed"] } });
    expect(bindingStickiness(compacted)).toEqual({
      kind: "reselect",
      reason: "reselection_point",
      ineligibility: [],
      points: ["compaction_completed"],
    });
    expect(decidePlacement(compacted)).toMatchObject({ connectionId: "codex-1" });
    // The session's model changed: its bound model is no candidate any more,
    // which is the re-selection point, not a forced restriction.
    const changed = sticky({
      session: { preferredModelId: "codex/b", reselectionPoints: ["model_changed"] },
    });
    expect(bindingStickiness(changed)).toEqual({
      kind: "reselect",
      reason: "reselection_point",
      ineligibility: [],
      points: ["model_changed"],
    });
    expect(decidePlacement(changed)).toMatchObject({ connectionId: "codex-1", modelId: "codex/b" });
    // Idle exactly the declared lifetime is still warm; one millisecond more is cold.
    const lifetime = cacheLifetimeMs(sticky().cacheFacts.codex);
    const edge = sticky({
      session: { binding: { ...warmBinding, lastModelCallAt: NOW - lifetime } },
    });
    expect(bindingStickiness(edge).kind).toBe("keep");
    const cold = sticky({
      session: { binding: { ...warmBinding, lastModelCallAt: NOW - lifetime - 1 } },
    });
    expect(bindingStickiness(cold)).toMatchObject({ kind: "reselect", reason: "cache_cold" });
    // Rotation applies again: the primary takes the cold session.
    expect(decidePlacement(cold)).toMatchObject({
      connectionId: "codex-1",
      switch: "reselected_cold",
    });
    // Cold re-selection may land on the same account when it still ranks first.
    const coldWithoutPrimary = sticky({
      settings: { rotation: { codex: { mode: "primary_first", primaryConnectionId: "codex-2" } } },
      session: { binding: { ...warmBinding, lastModelCallAt: NOW - lifetime - 1 } },
    });
    expect(bindingStickiness(coldWithoutPrimary).kind).toBe("reselect");
    expect(decidePlacement(coldWithoutPrimary)).toMatchObject({
      connectionId: "codex-2",
      switch: "sticky",
    });
    // A binding that never ran a model call is cold.
    const unused = sticky({ session: { binding: { ...warmBinding, lastModelCallAt: 0 } } });
    expect(bindingStickiness(unused)).toMatchObject({ kind: "reselect", reason: "cache_cold" });
  });

  test("SUB-STICK-04: the lifetime comes from each provider's declared cache facts", () => {
    const idle = 10 * 60_000;
    const world = sticky({
      session: { binding: { ...warmBinding, lastModelCallAt: NOW - idle } },
    });
    const declared = (facts: PlacementInput["cacheFacts"][string]) =>
      bindingStickiness({ ...world, cacheFacts: { codex: facts } }).kind;
    expect(declared({ kind: "exact_ttl", ttlMs: 5 * 60_000 })).toBe("reselect");
    expect(declared({ kind: "exact_ttl", ttlMs: 60 * 60_000 })).toBe("keep");
    expect(declared({ kind: "measured_idle_cutoff", cutoffMs: 9 * 60_000 })).toBe("reselect");
    expect(declared({ kind: "measured_idle_cutoff", cutoffMs: 20 * 60_000 })).toBe("keep");
    expect(declaredCacheLifetimeMs({ kind: "exact_ttl", ttlMs: 300_000 })).toBe(300_000);
    expect(declaredCacheLifetimeMs({ kind: "measured_idle_cutoff", cutoffMs: 3_600_000 })).toBe(
      3_600_000,
    );
    for (const lifetime of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => declaredCacheLifetimeMs({ kind: "exact_ttl", ttlMs: lifetime })).toThrow(
        "positive whole-millisecond cache lifetime",
      );
  });

  test("SUB-STICK-06, SUB-STICK-07: explicit choices are kept, and a shared session leaves a warm personal account", () => {
    const pinned = sticky({
      bound: { quota: quota({ exhaustedUntil: NOW + 60_000 }) },
      session: { binding: { ...warmBinding, choice: "explicit" } },
    });
    expect(decidePlacement(pinned)).toMatchObject({
      kind: "wait",
      reason: "pinned_account_unavailable",
    });
    const mine = personal("codex-mine", "codex");
    const shared = input({
      connections: [connection("codex-org", "codex"), mine],
      session: {
        visibility: "shared",
        personalAuthority: [{ provider: "codex", ownerMembershipId: "member-a" }],
        binding: { ...warmBinding, connectionId: "codex-mine" },
      },
    });
    expect(bindingStickiness(shared)).toMatchObject({
      kind: "reselect",
      reason: "account_ineligible",
      ineligibility: ["personal_not_owners_work"],
    });
    expect(decidePlacement(shared)).toMatchObject({ connectionId: "codex-org", personal: false });
  });

  test("SUB-STICK-03, SUB-STICK-07: a warm personal account is left once its authority or owner is gone", () => {
    const mine = personal("codex-mine", "codex");
    const owned = input({
      connections: [connection("codex-org", "codex"), mine],
      personalFallbackOptIn: true,
      session: {
        visibility: "private",
        personalAuthority: [{ provider: "codex", ownerMembershipId: "member-a" }],
        binding: { ...warmBinding, connectionId: "codex-mine" },
      },
    });
    // The owner's private session keeps its warm personal account.
    expect(bindingStickiness(owned)).toMatchObject({ kind: "keep", connectionId: "codex-mine" });
    const revoked = { ...owned, session: { ...owned.session, personalAuthority: [] } };
    const left = {
      ...owned,
      people: owned.people.map((person) => ({ ...person, active: false })),
    };
    for (const [name, world, why] of [
      ["no frozen authority", revoked, "personal_authority_missing"],
      ["the owner left", left, "personal_owner_inactive"],
    ] as const) {
      const verdict = bindingStickiness(world);
      expect({
        name,
        kind: verdict.kind,
        reason: verdict.kind === "reselect" && verdict.reason,
      }).toEqual({ name, kind: "reselect", reason: "account_ineligible" });
      expect({
        name,
        why: verdict.kind === "reselect" && verdict.ineligibility.includes(why),
      }).toEqual({ name, why: true });
      expect({ name, decision: decidePlacement(world) }).toMatchObject({
        name,
        decision: { kind: "run", connectionId: "codex-org", personal: false },
      });
    }
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
    const disabled = input({
      connections: [connection("codex-1", "codex", { allocatorEnabled: false })],
      session: { binding: explicit("codex-1") },
    });
    expect(decidePlacement(disabled)).toEqual({
      kind: "wait",
      reason: "pinned_account_disabled",
      earliestResetAt: null,
    });
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
  test("SUB-ELIG-06: fresh and stale telemetry do not outrank unknown quota", () => {
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
    expect(ranked(undefined)).toEqual(ranked(3_600_000));
    // The same spread hash decides regardless of which account has telemetry.
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

  test("SUB-ELIG-06: a header reading, refusal or partial usage reading that omits a running exhausted window keeps it until its reset; a complete usage reading or one that reports it again replaces it", () => {
    const weekly = { id: "weekly", usedPercent: 100, resetsAt: NOW + 86_400_000 };
    // Omitted windows that are not carried: one that is not exhausted, and
    // an exhausted one that resets exactly when the new reading is made.
    const current = quota({
      observedAt: NOW - 1_000,
      windows: [
        { id: "primary", usedPercent: 20, resetsAt: NOW + 3_600_000, status: "ok" },
        { ...weekly, status: "exhausted" },
        { id: "daily", usedPercent: 92, resetsAt: NOW + 7_200_000, status: "warning" },
        { id: "burst", usedPercent: 100, resetsAt: NOW, status: "exhausted" },
      ],
    });
    // A partial header reading (only the primary window) does not drop the block.
    const partial = quota({
      observedAt: NOW,
      source: "response_headers",
      windows: [{ id: "primary", usedPercent: 25, resetsAt: NOW + 3_600_000, status: "ok" }],
    });
    const kept = applyQuotaObservation({ refreshGeneration: 1, quota: current }, partial)!;
    expect(kept.windows).toEqual([...partial.windows, { ...weekly, status: "exhausted" }]);
    expect(quotaCapacity(kept, NOW + 1_000)).toEqual({
      kind: "exhausted",
      resetsAt: NOW + 86_400_000,
    });
    expect(quotaCapacity(kept, NOW + 86_400_001)).toEqual({ kind: "available" });
    // Neither does a refusal (which reports no windows).
    const refusal = quota({
      observedAt: NOW,
      source: "refusal",
      windows: [],
      exhaustedUntil: NOW + 60_000,
      exhaustedKind: "rate_limit",
    });
    const refused = applyQuotaObservation({ refreshGeneration: 1, quota: current }, refusal)!;
    expect(refused.windows).toEqual([{ ...weekly, status: "exhausted" }]);
    expect(quotaCapacity(refused, NOW + 120_000)).toEqual({
      kind: "exhausted",
      resetsAt: NOW + 86_400_000,
    });
    // A usage-endpoint reading of an adapter that declares its readings
    // complete: omitting the window ends it.
    const usage = { ...partial, source: "usage_endpoint" as const };
    expect(
      applyQuotaObservation({ refreshGeneration: 1, quota: current }, usage, {
        usageReadingsComplete: true,
      })!.windows,
    ).toEqual(usage.windows);
    // Without that declaration (absent or false) a usage reading is partial
    // and keeps the omitted block until its reset (fail closed).
    for (const options of [undefined, { usageReadingsComplete: false }]) {
      const partialUsage = applyQuotaObservation(
        { refreshGeneration: 1, quota: current },
        usage,
        options,
      )!;
      expect(partialUsage.windows).toEqual([...usage.windows, { ...weekly, status: "exhausted" }]);
      expect(quotaCapacity(partialUsage, NOW + 1_000)).toEqual({
        kind: "exhausted",
        resetsAt: NOW + 86_400_000,
      });
    }
    // The declaration never changes a header reading: it stays partial.
    expect(
      applyQuotaObservation({ refreshGeneration: 1, quota: current }, partial, {
        usageReadingsComplete: true,
      })!.windows,
    ).toEqual([...partial.windows, { ...weekly, status: "exhausted" }]);
    // A refusal's fallback window (core-synthesized, no known provider reset)
    // is replaced only by a complete usage reading.
    const fallback = quota({
      observedAt: NOW - 1_000,
      source: "refusal",
      windows: [
        {
          id: "exhausted_without_reset",
          usedPercent: 100,
          resetsAt: NOW + 60_000,
          status: "exhausted",
        },
      ],
    });
    expect(
      quotaCapacity(
        applyQuotaObservation({ refreshGeneration: 1, quota: fallback }, usage, {
          usageReadingsComplete: true,
        })!,
        NOW + 1_000,
      ),
    ).toEqual({ kind: "available" });
    expect(
      quotaCapacity(
        applyQuotaObservation({ refreshGeneration: 1, quota: fallback }, usage)!,
        NOW + 1_000,
      ),
    ).toEqual({ kind: "exhausted", resetsAt: NOW + 60_000 });
    // A reading that reports the window again shows an early reset.
    const reset = quota({
      observedAt: NOW + 2_000,
      source: "response_headers",
      windows: [
        { id: "primary", usedPercent: 25, resetsAt: NOW + 3_600_000, status: "ok" },
        { ...weekly, usedPercent: 0, status: "ok" },
      ],
    });
    const replaced = applyQuotaObservation({ refreshGeneration: 1, quota: kept }, reset)!;
    expect(replaced.windows).toEqual(reset.windows);
    expect(quotaCapacity(replaced, NOW + 3_000)).toEqual({ kind: "available" });
    // A window whose reset passed before the reading, or whose reset is
    // unknown, is not carried forward.
    const ended = quota({
      observedAt: NOW - 1_000,
      windows: [
        { id: "weekly", usedPercent: 100, resetsAt: NOW - 1, status: "exhausted" },
        { id: "daily", usedPercent: 100, resetsAt: null, status: "exhausted" },
      ],
    });
    expect(applyQuotaObservation({ refreshGeneration: 1, quota: ended }, partial)!.windows).toEqual(
      partial.windows,
    );
    // A reading for a newer credential generation starts afresh.
    expect(
      applyQuotaObservation(
        { refreshGeneration: 2, quota: current },
        { ...partial, observedRefreshGeneration: 2 },
      )!.windows,
    ).toEqual(partial.windows);
  });

  test("a block keeps a claim only while every observation that set its deadline explained it", () => {
    const until = NOW + 60_000;
    const claim = (windowIds: string[], at = NOW - 1_000, deadline = until) => ({
      until: deadline,
      observedAt: at,
      windowIds,
    });
    const claimed = quota({
      observedAt: NOW - 1_000,
      modelCooldowns: { "claude/a": until },
      modelCooldownClaims: { "claude/a": claim(["five_hour"]) },
      exhaustedUntil: until,
      exhaustedKind: "quota",
      exhaustedClaim: claim(["seven_day"]),
    });
    // Equal deadlines from two explained refusals: the window ids are joined.
    const again = quota({
      observedAt: NOW,
      source: "response_headers",
      modelCooldowns: { "claude/a": until },
      modelCooldownClaims: { "claude/a": claim(["seven_day_opus"], NOW) },
      exhaustedUntil: until,
      exhaustedKind: "quota",
      exhaustedClaim: claim(["five_hour"], NOW),
    });
    const joined = applyQuotaObservation({ refreshGeneration: 1, quota: claimed }, again)!;
    expect(quotaBlockClaim(joined, "claude/a")).toEqual(
      claim(["five_hour", "seven_day_opus"], NOW),
    );
    expect(quotaBlockClaim(joined, null)).toEqual(claim(["seven_day", "five_hour"], NOW));

    // An unexplained refusal with the same deadline drops the claim.
    const unexplained = quota({
      observedAt: NOW,
      source: "response_headers",
      modelCooldowns: { "claude/a": until },
      exhaustedUntil: until,
      exhaustedKind: "quota",
    });
    const dropped = applyQuotaObservation({ refreshGeneration: 1, quota: claimed }, unexplained)!;
    expect(dropped.modelCooldowns).toEqual({ "claude/a": until });
    expect(quotaBlockClaim(dropped, "claude/a")).toBeNull();
    expect(quotaBlockClaim(dropped, null)).toBeNull();
    expect(dropped.modelCooldownClaims).toBeUndefined();
    expect(dropped.exhaustedClaim).toBeUndefined();

    // A later unexplained deadline replaces the block, and its claim with it.
    const longer = applyQuotaObservation(
      { refreshGeneration: 1, quota: claimed },
      quota({
        observedAt: NOW,
        source: "response_headers",
        modelCooldowns: { "claude/a": until + 1 },
      }),
    )!;
    expect(longer.modelCooldowns).toEqual({ "claude/a": until + 1 });
    expect(quotaBlockClaim(longer, "claude/a")).toBeNull();
    // An earlier observation does not decide the kept deadline: its claim stands.
    const kept = applyQuotaObservation(
      { refreshGeneration: 1, quota: claimed },
      quota({
        observedAt: NOW,
        source: "usage_endpoint",
        modelCooldowns: { "claude/a": until - 1 },
      }),
    )!;
    expect(quotaBlockClaim(kept, "claude/a")).toEqual(claim(["five_hour"]));

    // A claim tied to another deadline, or naming no window, explains nothing.
    const mismatched = quota({
      modelCooldowns: { "claude/a": until, "claude/b": until },
      modelCooldownClaims: {
        "claude/a": claim(["five_hour"], NOW, until + 1),
        "claude/b": claim([]),
        "claude/c": claim(["five_hour"]),
      },
      exhaustedUntil: until,
      exhaustedClaim: claim(["seven_day"], NOW, until - 1),
    });
    expect(quotaBlockClaim(mismatched, "claude/a")).toBeNull();
    expect(quotaBlockClaim(mismatched, "claude/b")).toBeNull();
    expect(quotaBlockClaim(mismatched, "claude/c")).toBeNull();
    expect(quotaBlockClaim(mismatched, null)).toBeNull();
    const stored = storedQuotaDocument(mismatched);
    expect("modelCooldownClaims" in stored).toBe(false);
    expect("exhaustedClaim" in stored).toBe(false);
    expect(storedQuotaDocument(claimed)).toMatchObject({
      modelCooldownClaims: { "claude/a": claim(["five_hour"]) },
      exhaustedClaim: claim(["seven_day"]),
    });
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
      useOrganizationAccounts: false,
      enabled: false,
    });
  });
});

describe("Codex credit consent", () => {
  const exhausted = () =>
    quota({
      windows: [{ id: "weekly", usedPercent: 100, resetsAt: NOW + 3600000, status: "exhausted" }],
    });
  test("SUB-CREDITS-01: included allowance outranks primary and warm credit fallback; consent is account-specific", () => {
    const a = connection("a", "codex", { extraCreditsEnabled: true, quota: exhausted() });
    const b = connection("b", "codex");
    const world = input({
      connections: [a, b],
      settings: { rotation: { codex: { mode: "primary_first", primaryConnectionId: "a" } } },
      session: {
        onlyThisModel: true,
        binding: {
          connectionId: "a",
          provider: "codex",
          modelId: "codex/a",
          choice: "automatic",
          lastModelCallAt: NOW,
        },
      },
    });
    expect(decidePlacement(world)).toMatchObject({ kind: "run", connectionId: "b" });
    b.quota = exhausted();
    expect(decidePlacement(world)).toMatchObject({ kind: "run", connectionId: "a" });
    a.extraCreditsEnabled = false;
    expect(decidePlacement(world)).toMatchObject({ kind: "wait" });
  });
  test("real provider refusal and paused/model-excluded accounts stay blocked with consent", () => {
    for (const patch of [
      { quota: exhausted(), allocatorEnabled: false },
      { quota: quota({ exhaustedUntil: NOW + 60000, exhaustedKind: "quota", source: "refusal" }) },
      { quota: exhausted(), excludedModelIds: ["codex/a"] },
    ] satisfies Partial<SubscriptionConnection>[]) {
      expect(
        decidePlacement(
          input({
            connections: [connection("a", "codex", { extraCreditsEnabled: true, ...patch })],
            session: { onlyThisModel: true },
          }),
        ),
      ).toMatchObject({ kind: "wait" });
    }
  });
});

describe("subscription review regressions", () => {
  test("fresh personal connections work in their owner's Personal workspace without fallback opt-in", () => {
    const own = input({
      workspace: { kind: "personal", ownerMembershipId: "member-a" },
      settings: { personalFallbackAllowed: false },
      session: {
        visibility: "private",
        personalAuthority: [{ provider: "codex", ownerMembershipId: "member-a" }],
      },
      connections: [
        connection("personal", "codex", {
          ownership: { kind: "personal", ownerMembershipId: "member-a" },
        }),
      ],
    });
    expect(decidePlacement(own)).toMatchObject({ kind: "run", connectionId: "personal" });
    expect(checkPlacementDecision(own, decidePlacement(own))).toEqual([]);
    for (const denied of [
      { ...own, settings: { ...own.settings, personalConnectionsAllowed: false } },
      { ...own, session: { ...own.session, personalAuthority: [] } },
      {
        ...own,
        workspace: { ...own.workspace, kind: "shared" as const, ownerMembershipId: null },
        session: { ...own.session, visibility: "shared" as const },
      },
      { ...own, session: { ...own.session, ownerMembershipId: "member-b" } },
      { ...own, workspace: { ...own.workspace, kind: "shared" as const, ownerMembershipId: null } },
    ])
      expect(decidePlacement(denied)).toMatchObject({ kind: "wait" });
  });

  test("Spread actually sends new sessions to accounts with unknown quota", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const world = input({
        session: { id: `new-session-${i}` },
        connections: [
          connection("known", "codex"),
          connection("unknown", "codex", { quota: null }),
        ],
      });
      const decision = decidePlacement(world);
      if (decision.kind === "run") seen.add(decision.connectionId);
    }
    expect(seen).toEqual(new Set(["known", "unknown"]));
  });

  test("independent oracle covers credit consent, included alternatives, pins and provider refusals", () => {
    for (const reset of [null, NOW - 1, NOW + 60_000])
      for (const consent of [false, true])
        for (const refusal of [null, NOW + 30_000])
          for (const alternative of [false, true])
            for (const explicit of [false, true]) {
              const paid = connection("paid", "codex", {
                extraCreditsEnabled: consent,
                quota: quota({
                  windows: [
                    { id: "primary", usedPercent: 100, status: "exhausted", resetsAt: reset },
                  ],
                  exhaustedUntil: refusal,
                  exhaustedKind: refusal === null ? null : "quota",
                }),
              });
              const world = input({
                connections: [paid, ...(alternative ? [connection("included", "codex")] : [])],
                session: {
                  onlyThisModel: true,
                  binding: {
                    connectionId: "paid",
                    provider: "codex",
                    modelId: "codex/a",
                    choice: explicit ? "explicit" : "automatic",
                    lastModelCallAt: NOW,
                  },
                },
              });
              const decision = decidePlacement(world);
              expect(checkPlacementDecision(world, decision)).toEqual([]);
              const mapped = toReferenceWorld(world);
              const oracle = decideReference(mapped.world, mapped.sessionId, NOW);
              expect(oracle.kind).toBe(decision.kind);
              if (oracle.kind === "run" && decision.kind === "run")
                expect(oracle.connectionId).toBe(decision.connectionId);
            }
  });
});
