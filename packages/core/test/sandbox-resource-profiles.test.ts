import { describe, expect, test } from "bun:test";
import type {
  SandboxResourceProfileBinding,
  SandboxResourceProfileDeploymentConfig,
  SandboxResourceProfileRef,
  WorkspaceSandboxResourceProfilePolicy,
} from "@opengeni/contracts";
import {
  SandboxResourceProfileResolutionError,
  resolveSandboxResourceProfile,
  type ResolveSandboxResourceProfileInput,
} from "../src/domain/sandbox-resource-profiles";

const standard = {
  name: "standard-repository",
  version: 1,
  displayName: "Standard repository",
  description: null,
  resources: {
    cpuCores: { request: 2, limit: 4 },
    memoryMiB: { request: 1024, limit: 2048 },
  },
  supportedBackends: ["modal", "docker"],
  costPreview: null,
} as const;

const heavy = {
  ...standard,
  name: "heavy-build",
  resources: {
    cpuCores: { request: 4, limit: 8 },
    memoryMiB: { request: 4096, limit: 8192 },
  },
} as const;

const standardRef: SandboxResourceProfileRef = {
  name: standard.name,
  version: standard.version,
};
const heavyRef: SandboxResourceProfileRef = { name: heavy.name, version: heavy.version };
const deployment: SandboxResourceProfileDeploymentConfig = {
  profiles: [standard, heavy],
  default: standardRef,
  enforcement: "legacy_optional",
};
const workspacePolicy: WorkspaceSandboxResourceProfilePolicy = {
  allowed: [standardRef, heavyRef],
  default: heavyRef,
};

function resolve(overrides: Partial<ResolveSandboxResourceProfileInput> = {}) {
  return resolveSandboxResourceProfile({
    backend: "modal",
    deployment,
    workspacePolicy,
    ...overrides,
  });
}

function expectCode(fn: () => unknown, code: SandboxResourceProfileResolutionError["code"]): void {
  try {
    fn();
    throw new Error("expected sandbox resource profile resolution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxResourceProfileResolutionError);
    expect((error as SandboxResourceProfileResolutionError).code).toBe(code);
  }
}

describe("sandbox resource profile resolution", () => {
  test("uses deterministic explicit, rig, child, workspace, then deployment precedence", () => {
    expect(resolve({ explicitSession: standardRef, rig: standardRef }).source).toBe(
      "explicit_session",
    );
    expect(resolve({ rig: standardRef }).source).toBe("rig");
    expect(resolve({ inheritedChild: standardRef }).source).toBe("inherited_child");
    expect(resolve().source).toBe("workspace_default");
    expect(resolve({ workspacePolicy: { allowed: [standardRef], default: null } }).source).toBe(
      "deployment_default",
    );
  });

  test("rejects any disagreement among non-null immutable selectors", () => {
    expectCode(() => resolve({ explicitSession: standardRef, rig: heavyRef }), "selector_mismatch");
    expectCode(() => resolve({ rig: standardRef, inheritedChild: heavyRef }), "selector_mismatch");
  });

  test("requires every new-group selection to be exactly allowlisted", () => {
    expectCode(
      () => resolve({ workspacePolicy: { allowed: [heavyRef], default: null } }),
      "profile_not_allowed",
    );
    expectCode(
      () =>
        resolve({
          explicitSession: standardRef,
          workspacePolicy: { allowed: [heavyRef], default: heavyRef },
        }),
      "profile_not_allowed",
    );
  });

  test("does not let a deployment default bypass an absent workspace allowlist", () => {
    expectCode(
      () => resolve({ workspacePolicy: { allowed: [], default: null } }),
      "profile_not_allowed",
    );
  });

  test("returns legacy null only when omission is allowed", () => {
    expect(
      resolve({
        deployment: { profiles: [], default: null, enforcement: "legacy_optional" },
        workspacePolicy: { allowed: [], default: null },
      }),
    ).toEqual({ binding: null, source: "legacy_unprofiled" });
    expectCode(
      () =>
        resolve({
          deployment: { profiles: [], default: null, enforcement: "required" },
          workspacePolicy: { allowed: [], default: null },
        }),
      "profile_required",
    );
  });

  test("resolves exact configured finite values and rejects unsupported backends", () => {
    const result = resolve({ explicitSession: standardRef });
    expect(result.binding).toEqual({
      schemaVersion: 1,
      profile: standardRef,
      resources: standard.resources,
    });
    expectCode(
      () => resolve({ explicitSession: standardRef, backend: "e2b" }),
      "backend_unsupported",
    );
    expectCode(
      () => resolve({ explicitSession: { name: "missing", version: 1 } }),
      "profile_not_allowed",
    );
  });

  test("keeps an existing group binding immutable across mutable default and allowlist changes", () => {
    const existingBinding: SandboxResourceProfileBinding = {
      schemaVersion: 1,
      profile: standardRef,
      resources: standard.resources,
    };
    expect(
      resolve({
        existingBinding,
        workspacePolicy: { allowed: [heavyRef], default: heavyRef },
      }),
    ).toEqual({ binding: existingBinding, source: "persisted_group" });
    expectCode(() => resolve({ existingBinding, explicitSession: heavyRef }), "selector_mismatch");
  });

  test("keeps existing legacy-null groups null and rejects join-time upgrades", () => {
    expect(
      resolve({ existingBinding: null, deployment: { ...deployment, enforcement: "required" } }),
    ).toEqual({ binding: null, source: "legacy_unprofiled" });
    expectCode(
      () => resolve({ existingBinding: null, inheritedChild: standardRef }),
      "selector_mismatch",
    );
  });

  test("rejects invalid workspace policy with a typed code", () => {
    expectCode(
      () =>
        resolve({
          workspacePolicy: {
            allowed: [],
            default: standardRef,
          },
        }),
      "invalid_workspace_policy",
    );
  });
});
