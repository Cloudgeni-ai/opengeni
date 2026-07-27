import {
  SandboxResourceProfileBinding,
  SandboxResourceProfileDeploymentConfig,
  WorkspaceSandboxResourceProfilePolicy,
  sandboxResourceProfileRefKey,
  sandboxResourceProfileRefsEqual,
  type SandboxBackend,
  type SandboxResourceProfileBinding as SandboxResourceProfileBindingType,
  type SandboxResourceProfileDeploymentConfig as SandboxResourceProfileDeploymentConfigType,
  type SandboxResourceProfileRef,
  type WorkspaceSandboxResourceProfilePolicy as WorkspaceSandboxResourceProfilePolicyType,
} from "@opengeni/contracts";

export const SANDBOX_RESOURCE_PROFILE_RESOLUTION_ERROR_CODES = [
  "selector_mismatch",
  "profile_not_allowed",
  "profile_not_configured",
  "profile_required",
  "backend_unsupported",
  "invalid_workspace_policy",
] as const;
export type SandboxResourceProfileResolutionErrorCode =
  (typeof SANDBOX_RESOURCE_PROFILE_RESOLUTION_ERROR_CODES)[number];

export class SandboxResourceProfileResolutionError extends Error {
  readonly code: SandboxResourceProfileResolutionErrorCode;

  constructor(code: SandboxResourceProfileResolutionErrorCode, message: string) {
    super(message);
    this.name = "SandboxResourceProfileResolutionError";
    this.code = code;
  }
}

export type SandboxResourceProfileSelectionSource =
  | "persisted_group"
  | "explicit_session"
  | "rig"
  | "inherited_child"
  | "workspace_default"
  | "deployment_default"
  | "legacy_unprofiled";

export type ResolvedSandboxResourceProfile = {
  binding: SandboxResourceProfileBindingType | null;
  source: SandboxResourceProfileSelectionSource;
};

export type ResolveSandboxResourceProfileInput = {
  backend: SandboxBackend;
  deployment: SandboxResourceProfileDeploymentConfigType;
  workspacePolicy: WorkspaceSandboxResourceProfilePolicyType;
  explicitSession?: SandboxResourceProfileRef | null;
  rig?: SandboxResourceProfileRef | null;
  inheritedChild?: SandboxResourceProfileRef | null;
  /** Undefined means a new group; null means an existing legacy-unprofiled group. */
  existingBinding?: SandboxResourceProfileBindingType | null;
};

type Selector = {
  source: "explicit_session" | "rig" | "inherited_child";
  ref: SandboxResourceProfileRef;
};

function resolutionError(code: SandboxResourceProfileResolutionErrorCode, message: string): never {
  throw new SandboxResourceProfileResolutionError(code, message);
}

function configuredProfile(
  deployment: SandboxResourceProfileDeploymentConfigType,
  ref: SandboxResourceProfileRef,
  backend: SandboxBackend,
) {
  const key = sandboxResourceProfileRefKey(ref);
  const profile = deployment.profiles.find(
    (candidate) => sandboxResourceProfileRefKey(candidate) === key,
  );
  if (!profile) {
    resolutionError(
      "profile_not_configured",
      `sandbox resource profile ${key} is not configured in this deployment`,
    );
  }
  if (!profile.supportedBackends.includes(backend)) {
    resolutionError(
      "backend_unsupported",
      `sandbox resource profile ${key} does not support backend ${backend}`,
    );
  }
  return profile;
}

function selectorsFrom(input: ResolveSandboxResourceProfileInput): Selector[] {
  return [
    ...(input.explicitSession
      ? [{ source: "explicit_session" as const, ref: input.explicitSession }]
      : []),
    ...(input.rig ? [{ source: "rig" as const, ref: input.rig }] : []),
    ...(input.inheritedChild
      ? [{ source: "inherited_child" as const, ref: input.inheritedChild }]
      : []),
  ];
}

function assertSelectorsAgree(selectors: Selector[]): void {
  const first = selectors[0];
  if (!first) return;
  const mismatch = selectors.find(
    (selector) => !sandboxResourceProfileRefsEqual(selector.ref, first.ref),
  );
  if (mismatch) {
    resolutionError(
      "selector_mismatch",
      `${mismatch.source} selected ${sandboxResourceProfileRefKey(mismatch.ref)}, which conflicts with ${first.source} selection ${sandboxResourceProfileRefKey(first.ref)}`,
    );
  }
}

function parseInputs(input: ResolveSandboxResourceProfileInput): {
  deployment: SandboxResourceProfileDeploymentConfigType;
  workspacePolicy: WorkspaceSandboxResourceProfilePolicyType;
  existingBinding: SandboxResourceProfileBindingType | null | undefined;
} {
  const deployment = SandboxResourceProfileDeploymentConfig.safeParse(input.deployment);
  if (!deployment.success) {
    resolutionError(
      "profile_not_configured",
      `sandbox resource profile deployment catalog is invalid: ${deployment.error.message}`,
    );
  }
  const workspacePolicy = WorkspaceSandboxResourceProfilePolicy.safeParse(input.workspacePolicy);
  if (!workspacePolicy.success) {
    resolutionError(
      "invalid_workspace_policy",
      `workspace sandbox resource profile policy is invalid: ${workspacePolicy.error.message}`,
    );
  }
  if (input.existingBinding === undefined) {
    return {
      deployment: deployment.data,
      workspacePolicy: workspacePolicy.data,
      existingBinding: undefined,
    };
  }
  if (input.existingBinding === null) {
    return {
      deployment: deployment.data,
      workspacePolicy: workspacePolicy.data,
      existingBinding: null,
    };
  }
  const existingBinding = SandboxResourceProfileBinding.safeParse(input.existingBinding);
  if (!existingBinding.success) {
    resolutionError(
      "profile_not_configured",
      `persisted sandbox resource profile binding is invalid: ${existingBinding.error.message}`,
    );
  }
  return {
    deployment: deployment.data,
    workspacePolicy: workspacePolicy.data,
    existingBinding: existingBinding.data,
  };
}

/**
 * Resolve one immutable group binding before provider effects.
 *
 * Existing groups never track mutable workspace/deployment defaults. A
 * persisted binding wins, while an explicit/rig/child selector must agree with
 * it. Existing legacy-null groups remain null and cannot be upgraded by join.
 * New groups apply exact selectors followed by workspace then deployment
 * defaults; every resulting selection must appear in the workspace allowlist.
 */
export function resolveSandboxResourceProfile(
  input: ResolveSandboxResourceProfileInput,
): ResolvedSandboxResourceProfile {
  const { deployment, workspacePolicy, existingBinding } = parseInputs(input);
  const selectors = selectorsFrom(input);
  assertSelectorsAgree(selectors);

  if (existingBinding !== undefined) {
    if (existingBinding === null) {
      if (selectors.length > 0) {
        resolutionError(
          "selector_mismatch",
          `existing legacy-unprofiled sandbox group cannot be upgraded by selector ${sandboxResourceProfileRefKey(selectors[0]!.ref)}`,
        );
      }
      return { binding: null, source: "legacy_unprofiled" };
    }

    const mismatch = selectors.find(
      (selector) => !sandboxResourceProfileRefsEqual(selector.ref, existingBinding.profile),
    );
    if (mismatch) {
      resolutionError(
        "selector_mismatch",
        `${mismatch.source} selected ${sandboxResourceProfileRefKey(mismatch.ref)}, but the existing sandbox group is immutably bound to ${sandboxResourceProfileRefKey(existingBinding.profile)}`,
      );
    }
    configuredProfile(deployment, existingBinding.profile, input.backend);
    return { binding: existingBinding, source: "persisted_group" };
  }

  const selected =
    selectors[0] ??
    (workspacePolicy.default
      ? { source: "workspace_default" as const, ref: workspacePolicy.default }
      : deployment.default
        ? { source: "deployment_default" as const, ref: deployment.default }
        : null);
  if (!selected) {
    if (deployment.enforcement === "required") {
      resolutionError(
        "profile_required",
        "a sandbox resource profile is required for new sandbox groups",
      );
    }
    return { binding: null, source: "legacy_unprofiled" };
  }

  const key = sandboxResourceProfileRefKey(selected.ref);
  const allowed = workspacePolicy.allowed.some(
    (candidate) => sandboxResourceProfileRefKey(candidate) === key,
  );
  if (!allowed) {
    resolutionError(
      "profile_not_allowed",
      `sandbox resource profile ${key} is not in the workspace exact allowlist`,
    );
  }
  const profile = configuredProfile(deployment, selected.ref, input.backend);
  return {
    binding: {
      schemaVersion: 1,
      profile: { name: profile.name, version: profile.version },
      resources: profile.resources,
    },
    source: selected.source,
  };
}
