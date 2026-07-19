import { describe, expect, test } from "bun:test";
import {
  capabilityCatalogItemIsTrustedForExposure,
  SessionEffectiveToolPolicy,
  SessionToolPolicy,
} from "../src";

describe("session tool policy contracts", () => {
  test("accepts the durable policy modes and rejects invalid inheritance", () => {
    expect(SessionToolPolicy.parse({ mode: "legacy", inheritedFromSessionId: null })).toEqual({
      mode: "legacy",
      inheritedFromSessionId: null,
    });
    expect(() =>
      SessionToolPolicy.parse({ mode: "explicit", inheritedFromSessionId: "not-a-uuid" }),
    ).toThrow();
  });

  test("effective policy is ID-only and bounded by contract", () => {
    const policy = SessionEffectiveToolPolicy.parse({
      mode: "explicit",
      inheritedFromSessionId: null,
      selectedIds: ["cap-docs"],
      effectiveIds: ["cap-docs", "opengeni"],
      mandatoryIds: ["opengeni"],
      lazyRouter: { state: "disabled", deferredIds: [] },
      configuredIds: ["cap-docs", "opengeni"],
      droppedIds: [],
      counts: { selected: 1, effective: 2, mandatory: 1, deferred: 0, configured: 2, dropped: 0 },
      idsTruncated: false,
    });
    expect(JSON.stringify(policy)).not.toContain("https://");
    expect(JSON.stringify(policy)).not.toContain("secret");
    expect(() =>
      SessionEffectiveToolPolicy.parse({
        ...policy,
        effectiveIds: Array.from({ length: 65 }, (_, index) => `cap-${index}`),
      }),
    ).toThrow();
  });
});

describe("catalog exposure trust", () => {
  const probe = { mcpProbe: { status: "real", reason: "test_fixture" } };

  test("fails closed for stale, missing, unverified, and unknown-auth registry rows", () => {
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: true,
        authKind: "none",
        metadata: probe,
      }),
    ).toBe(false);
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: false,
        authKind: "none",
        metadata: {},
      }),
    ).toBe(false);
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: false,
        authKind: "unknown",
        metadata: probe,
      }),
    ).toBe(false);
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: false,
        authKind: "none",
        metadata: { mcpProbe: { status: "unverified" } },
      }),
    ).toBe(false);
  });

  test("requires an actionable contract for API-key rows", () => {
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: false,
        authKind: "api_key",
        metadata: probe,
      }),
    ).toBe(false);
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: false,
        authKind: "api_key",
        metadata: {
          ...probe,
          authContract: { headerName: "Authorization", scheme: "Bearer" },
        },
      }),
    ).toBe(true);
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "registry",
        stale: false,
        authKind: "api_key",
        metadata: { ...probe, authContract: { headerName: "Authorization:bad", scheme: "Bearer" } },
      }),
    ).toBe(false);
  });

  test("non-registry rows preserve the existing trusted source contract", () => {
    expect(
      capabilityCatalogItemIsTrustedForExposure({
        source: "configured",
        stale: false,
        authKind: null,
        metadata: {},
      }),
    ).toBe(true);
  });
});
