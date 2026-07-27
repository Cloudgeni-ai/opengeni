import { describe, expect, test } from "bun:test";
import {
  configuredSandboxResourceProfiles,
  getSettings,
  parseSandboxResourceProfilesJson,
} from "../src";

const profile = {
  name: "standard-repository",
  version: 2,
  displayName: "Standard repository",
  description: "Finite resources for ordinary repository work.",
  resources: {
    cpuCores: { request: 2, limit: 4 },
    memoryMiB: { request: 1024, limit: 2048 },
  },
  supportedBackends: ["modal"],
  costPreview: {
    source: "public_rate_card",
    currency: "USD",
    requestFloorPerActiveHour: 0.25,
    limitCeilingPerActiveHour: 0.5,
    capturedAt: "2026-07-21T00:00:00Z",
    sourceUrl: "https://modal.com/pricing",
  },
} as const;

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

describe("sandbox resource profile deployment config", () => {
  test("defaults to an empty legacy-optional catalog", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.sandboxResourceProfilesJson).toBe(
      '{"profiles":[],"default":null,"enforcement":"legacy_optional"}',
    );
    expect(configuredSandboxResourceProfiles(settings)).toEqual({
      profiles: [],
      default: null,
      enforcement: "legacy_optional",
    });
  });

  test("parses exact finite values without selecting provisional defaults", () => {
    const config = {
      profiles: [profile],
      default: { name: profile.name, version: profile.version },
      enforcement: "required",
    } as const;
    expect(parseSandboxResourceProfilesJson(JSON.stringify(config))).toEqual(config);
  });

  test("rejects malformed JSON at settings validation", () => {
    expect(() =>
      withEnv({ OPENGENI_SANDBOX_RESOURCE_PROFILES_JSON: "[not-json" }, () => getSettings()),
    ).toThrow("OPENGENI_SANDBOX_RESOURCE_PROFILES_JSON must be valid JSON");
  });

  test("rejects duplicate identities and an unknown exact default", () => {
    expect(() =>
      parseSandboxResourceProfilesJson(JSON.stringify({ profiles: [profile, profile] })),
    ).toThrow("duplicate immutable profile identity");
    expect(() =>
      parseSandboxResourceProfilesJson(
        JSON.stringify({
          profiles: [profile],
          default: { name: "unconfigured", version: 1 },
        }),
      ),
    ).toThrow("deployment default must name an exact configured profile");
  });
});
