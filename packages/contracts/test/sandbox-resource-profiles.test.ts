import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  SandboxResourceProfileBinding,
  SandboxResourceProfileDefinition,
  SandboxResourceProfileDeploymentConfig,
  SandboxResourceProfileRef,
  WorkspaceSandboxResourceProfilePolicy,
  sandboxResourceProfileRefKey,
  sandboxResourceProfileRefsEqual,
  type SandboxResourceProfileDefinition as SandboxResourceProfileDefinitionType,
} from "../src";

const resources = {
  cpuCores: { request: 2.5, limit: 4 },
  memoryMiB: { request: 768, limit: 1536 },
};

const profile: SandboxResourceProfileDefinitionType = {
  name: "standard-repository",
  version: 1,
  displayName: "Standard repository",
  description: null,
  resources,
  supportedBackends: ["modal"],
  costPreview: {
    source: "public_rate_card",
    currency: "USD",
    requestFloorPerActiveHour: 0.3728,
    limitCeilingPerActiveHour: 0.6037,
    capturedAt: "2026-07-21T00:00:00Z",
    sourceUrl: "https://modal.com/pricing",
  },
};

describe("sandbox resource profile contracts", () => {
  test("accepts an exact immutable identity and resolved finite values", () => {
    expect(SandboxResourceProfileRef.parse({ name: "standard-repository", version: 1 })).toEqual({
      name: "standard-repository",
      version: 1,
    });
    expect(SandboxResourceProfileDefinition.parse(profile)).toEqual(profile);
    expect(
      SandboxResourceProfileBinding.parse({
        schemaVersion: 1,
        profile: { name: profile.name, version: profile.version },
        resources,
      }),
    ).toEqual({
      schemaVersion: 1,
      profile: { name: profile.name, version: profile.version },
      resources,
    });
  });

  test("rejects mutable aliases, extra fields, non-finite resources, and request above limit", () => {
    expect(() => SandboxResourceProfileRef.parse({ name: "latest", version: "latest" })).toThrow();
    expect(() => SandboxResourceProfileRef.parse({ name: "Standard", version: 1 })).toThrow();
    expect(() =>
      SandboxResourceProfileDefinition.parse({
        ...profile,
        resources: { ...resources, cpuCores: { request: Number.POSITIVE_INFINITY, limit: 4 } },
      }),
    ).toThrow();
    expect(() =>
      SandboxResourceProfileDefinition.parse({
        ...profile,
        resources: { ...resources, memoryMiB: { request: 2048, limit: 1024 } },
      }),
    ).toThrow("memory request must not exceed");
    expect(() =>
      SandboxResourceProfileRef.parse({ name: "standard", version: 1, provider: "modal" }),
    ).toThrow();
  });

  test("keeps public rate-card estimates explicitly distinct from invoice truth", () => {
    expect(() =>
      SandboxResourceProfileDefinition.parse({
        ...profile,
        costPreview: { ...profile.costPreview, source: "invoice" },
      }),
    ).toThrow();
    expect(() =>
      SandboxResourceProfileDefinition.parse({
        ...profile,
        costPreview: {
          ...profile.costPreview,
          requestFloorPerActiveHour: 1,
          limitCeilingPerActiveHour: 0.5,
        },
      }),
    ).toThrow("request-floor estimate must not exceed");
  });

  test("rejects duplicate identities, duplicate backends, and an unknown deployment default", () => {
    expect(() =>
      SandboxResourceProfileDeploymentConfig.parse({ profiles: [profile, profile] }),
    ).toThrow("duplicate immutable profile identity");
    expect(() =>
      SandboxResourceProfileDefinition.parse({
        ...profile,
        supportedBackends: ["modal", "modal"],
      }),
    ).toThrow("supported backends must be unique");
    expect(() =>
      SandboxResourceProfileDeploymentConfig.parse({
        profiles: [profile],
        default: { name: "heavy-build", version: 1 },
      }),
    ).toThrow("deployment default must name");
  });

  test("requires a workspace default to be in the exact allowlist", () => {
    expect(() =>
      WorkspaceSandboxResourceProfilePolicy.parse({
        allowed: [],
        default: { name: profile.name, version: profile.version },
      }),
    ).toThrow("workspace default must also appear");
  });

  test("uses stable ref keys and value equality", () => {
    const ref = { name: profile.name, version: profile.version };
    expect(sandboxResourceProfileRefKey(ref)).toBe("standard-repository@1");
    expect(sandboxResourceProfileRefsEqual(ref, { ...ref })).toBe(true);
    expect(sandboxResourceProfileRefsEqual(ref, { ...ref, version: 2 })).toBe(false);
    expect(sandboxResourceProfileRefsEqual(null, undefined)).toBe(false);
  });

  test("does not grant explicit compute-profile selection to default program agents", () => {
    expect(DEFAULT_FIRST_PARTY_MCP_PERMISSIONS).not.toContain("sandbox_profiles:use");
  });
});
