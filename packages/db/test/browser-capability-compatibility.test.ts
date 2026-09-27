import { expect, test } from "bun:test";
import {
  browserSessionCreateRequestDigest,
  LIGHTPANDA_BROWSER_SESSION_CAPABILITIES,
  MANAGED_BROWSER_SESSION_CAPABILITIES,
  readStoredBrowserCapabilities,
} from "../src/browser-sessions";

test("Lightpanda create retries retain their legacy digest without accepting changed input", () => {
  const input = {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    operationId: "33333333-3333-4333-8333-333333333333",
    associatedSessionId: "44444444-4444-4444-8444-444444444444",
    actorSubjectId: "test-user",
    name: "Semantic browser",
    initialUrl: "https://example.com/",
    placement: {
      kind: "sandbox_group" as const,
      sandboxGroupId: "55555555-5555-4555-8555-555555555555",
    },
    driverId: "opengeni.lightpanda.cdp.v1",
    engine: "lightpanda" as const,
    headless: true,
    identityId: null,
    baseRevisionId: null,
    capabilities: LIGHTPANDA_BROWSER_SESSION_CAPABILITIES,
  };
  const legacyDigest = browserSessionCreateRequestDigest({
    ...input,
    capabilities: { ...input.capabilities, screenshots: true },
  });
  // Computed by the pre-correction version 4 implementation.
  expect(legacyDigest).toBe("b6cea0271b4727af2da292336d9a9487bea9fb66c4c30bf87008cc6007c0f531");
  expect(browserSessionCreateRequestDigest(input)).toBe(legacyDigest);
  expect(browserSessionCreateRequestDigest({ ...input, name: "Other browser" })).not.toBe(
    legacyDigest,
  );
  expect(
    browserSessionCreateRequestDigest({ ...input, initialUrl: "https://other.test/" }),
  ).not.toBe(legacyDigest);
});

test("Lightpanda never advertises placeholder screenshots, including stored legacy sessions", () => {
  expect(LIGHTPANDA_BROWSER_SESSION_CAPABILITIES.screenshots).toBe(false);
  const legacy = { ...LIGHTPANDA_BROWSER_SESSION_CAPABILITIES, screenshots: true };
  expect(readStoredBrowserCapabilities(legacy, "lightpanda")).toEqual({
    ...legacy,
    screenshots: false,
  });
  expect(readStoredBrowserCapabilities(MANAGED_BROWSER_SESSION_CAPABILITIES, "chromium")).toEqual(
    MANAGED_BROWSER_SESSION_CAPABILITIES,
  );
});

test("legacy browser capabilities remain readable without granting permission control", () => {
  const { permissions: _permissions, ...legacy } = MANAGED_BROWSER_SESSION_CAPABILITIES;
  expect(readStoredBrowserCapabilities(legacy)).toEqual({ ...legacy, permissions: false });
  expect(readStoredBrowserCapabilities(MANAGED_BROWSER_SESSION_CAPABILITIES).permissions).toBe(
    true,
  );
  expect(() => readStoredBrowserCapabilities({ ...legacy, permissions: "true" })).toThrow();
  expect(() => readStoredBrowserCapabilities({ ...legacy, permissions: null })).toThrow();
  expect(() => readStoredBrowserCapabilities({ permissions: false })).toThrow();
});
