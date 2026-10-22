// Pure checks for organization settings with lockable workspace overrides
// (SUB-SET-01..05). The SQL guard and resolver are compared with these
// mirrors on real PostgreSQL in packages/db/test/subscription-settings-postgres.test.ts.
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_ORDER_LIMITS,
  fallbackOrderFor,
  fallbackOrderProblem,
  isSubscriptionSettingKey,
  jsonEqual,
  lockedSettingsWidened,
  settingsView,
  type SubscriptionSettingsPolicy,
} from "../src";

const organization: SubscriptionSettingsPolicy["organization"] = {
  rotation: { codex: { mode: "spread" } },
  providers: {},
  crossProviderFailover: false,
  fallbackOrder: { "codex/a": ["codex/b"] },
  personalConnectionsAllowed: true,
  personalFallbackAllowed: false,
};

describe("settings view sources", () => {
  test("organization, workspace and locked sources per setting", () => {
    const view = settingsView(
      {
        organization,
        locked: ["crossProviderFailover"],
        workspaces: {
          w1: {
            crossProviderFailover: true,
            personalConnectionsAllowed: false,
            fallbackOrder: { "claude/c": ["codex/a"] },
          },
        },
      },
      "w1",
    );
    expect(view.values.crossProviderFailover).toBe(false);
    expect(view.sources.crossProviderFailover).toBe("locked");
    expect(view.values.personalConnectionsAllowed).toBe(false);
    expect(view.sources.personalConnectionsAllowed).toBe("workspace");
    expect(view.sources.personalFallbackAllowed).toBe("organization");
    expect(view.sources.fallbackOrder).toBe("workspace");
    expect(view.entrySources.fallbackOrder).toEqual({
      "codex/a": "organization",
      "claude/c": "workspace",
    });
    expect(view.sources.rotation).toBe("organization");
  });

  test("a workspace without a row inherits everything", () => {
    const view = settingsView({ organization, locked: [], workspaces: {} }, "none");
    expect(Object.values(view.sources).every((source) => source === "organization")).toBe(true);
    expect(view.values.fallbackOrder).toEqual(organization.fallbackOrder);
  });
});

describe("SUB-SET-02: lockedSettingsWidened (mirror of the database guard)", () => {
  test("setting or changing a locked scalar widens; clearing or keeping it does not", () => {
    const locked = ["personalConnectionsAllowed"] as const;
    expect(
      lockedSettingsWidened({ locked, before: null, after: { personalConnectionsAllowed: false } }),
    ).toEqual(["personalConnectionsAllowed"]);
    expect(
      lockedSettingsWidened({
        locked,
        before: { personalConnectionsAllowed: false },
        after: { personalConnectionsAllowed: false },
      }),
    ).toEqual([]);
    expect(
      lockedSettingsWidened({
        locked,
        before: { personalConnectionsAllowed: false },
        after: {},
      }),
    ).toEqual([]);
    expect(
      lockedSettingsWidened({ locked, before: null, after: { personalFallbackAllowed: true } }),
    ).toEqual([]);
  });

  test("map-valued locks: an added or changed entry widens; removing entries does not", () => {
    const locked = ["fallbackOrder"] as const;
    const before = { fallbackOrder: { "codex/a": ["codex/b"], "claude/c": [] } };
    expect(
      lockedSettingsWidened({
        locked,
        before,
        after: { fallbackOrder: { "codex/a": ["codex/b"] } },
      }),
    ).toEqual([]);
    expect(
      lockedSettingsWidened({
        locked,
        before,
        after: { fallbackOrder: { "codex/a": ["claude/c"] } },
      }),
    ).toEqual(["fallbackOrder"]);
    expect(
      lockedSettingsWidened({
        locked,
        before,
        after: { fallbackOrder: { ...before.fallbackOrder, "xai/d": [] } },
      }),
    ).toEqual(["fallbackOrder"]);
  });

  test("a rotation lock covers newly set primary connections", () => {
    const locked = ["rotation"] as const;
    const unchanged = { before: { codex: "p1" }, after: { codex: "p1" } };
    expect(
      lockedSettingsWidened({ locked, before: null, after: null, primaryConnectionIds: unchanged }),
    ).toEqual([]);
    expect(
      lockedSettingsWidened({
        locked,
        before: null,
        after: null,
        primaryConnectionIds: { before: { codex: "p1" }, after: { codex: "p2" } },
      }),
    ).toEqual(["rotation"]);
    expect(
      lockedSettingsWidened({
        locked,
        before: null,
        after: null,
        primaryConnectionIds: { before: { codex: "p1" }, after: { codex: null } },
      }),
    ).toEqual([]);
  });
});

describe("fallback order", () => {
  test("valid orders and each refusal", () => {
    expect(fallbackOrderProblem({})).toBeNull();
    expect(fallbackOrderProblem({ "codex/a": ["claude/b", "xai/c"], "claude/b": [] })).toBeNull();
    expect(fallbackOrderProblem(null)).not.toBeNull();
    expect(fallbackOrderProblem([])).not.toBeNull();
    expect(fallbackOrderProblem({ "codex/a": "claude/b" })).not.toBeNull();
    expect(fallbackOrderProblem({ "codex/a": ["codex/a"] })).not.toBeNull();
    expect(fallbackOrderProblem({ "codex/a": ["claude/b", "claude/b"] })).not.toBeNull();
    expect(fallbackOrderProblem({ "codex/a": [" claude/b"] })).not.toBeNull();
    expect(fallbackOrderProblem({ "": [] })).not.toBeNull();
    expect(fallbackOrderProblem({ "codex/a": [7] })).not.toBeNull();
    const tooMany = Array.from(
      { length: FALLBACK_ORDER_LIMITS.fallbacksPerModel + 1 },
      (_, i) => `m/${i}`,
    );
    expect(fallbackOrderProblem({ "codex/a": tooMany })).not.toBeNull();
    const tooManyModels = Object.fromEntries(
      Array.from({ length: FALLBACK_ORDER_LIMITS.preferredModels + 1 }, (_, i) => [`m/${i}`, []]),
    );
    expect(fallbackOrderProblem(tooManyModels)).not.toBeNull();
    expect(
      fallbackOrderProblem({ ["x".repeat(FALLBACK_ORDER_LIMITS.modelIdLength + 1)]: [] }),
    ).not.toBeNull();
  });

  test("fallbackOrderFor reads the effective order", () => {
    expect(fallbackOrderFor(organization, "codex/a")).toEqual(["codex/b"]);
    expect(fallbackOrderFor(organization, "codex/unknown")).toEqual([]);
  });
});

test("setting keys and JSON equality", () => {
  expect(isSubscriptionSettingKey("rotation")).toBe(true);
  expect(isSubscriptionSettingKey("models")).toBe(false);
  expect(isSubscriptionSettingKey(1)).toBe(false);
  expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
  expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  expect(jsonEqual({ a: null }, {})).toBe(false);
});
