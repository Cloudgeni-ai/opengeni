import type {
  AppAvailableRuntimeCatalogResponse,
  AppRuntimeCatalogResponse,
  AppRuntimeToolCallRequest,
  AppRuntimeToolCallResponse,
} from "@opengeni/contracts/apps";
import type {
  CanonicalToolDescriptor,
  CanonicalToolIdentity,
  CanonicalToolResult,
} from "@opengeni/contracts";
import {
  assertCanonicalToolInput,
  assertCanonicalToolOutput,
  canonicalToolIdentityKey,
  compileCanonicalToolSchemaValidators,
  inspectCanonicalToolResult,
  invokeCanonicalTool,
  isCanonicalSafeReadToolEligible,
  sortCanonicalToolDescriptors,
  type CanonicalToolInvocationContext,
} from "@opengeni/tool-runtime";
import { AppToolDescriptor as AppToolDescriptorSchema } from "@opengeni/contracts/apps";
import { hasPermission } from "../access";
import type { AppCurrentHumanAuthority } from "./apps";

export const APP_RUNTIME_TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;
export const APP_RUNTIME_TOOL_RESULT_MAX_BYTES = 4 * 1024 * 1024;
export const APP_RUNTIME_TOOL_TIMEOUT_MS = 60_000;

export type AppRuntimePolicySnapshot = Readonly<{
  appId: string;
  releaseId: string;
  toolPolicyRevisionId: string;
  catalogDigest: string;
  allowedTools: readonly CanonicalToolIdentity[];
}>;

export type AppRuntimeInvocationCaller = Readonly<{
  authority: AppCurrentHumanAuthority;
  appId: string;
  releaseId: string;
}>;

export type AppRuntimeToolBinding = Readonly<{
  descriptor: CanonicalToolDescriptor;
  invoke(
    argumentsValue: Record<string, unknown>,
    context: CanonicalToolInvocationContext<AppRuntimeInvocationCaller>,
  ): Promise<CanonicalToolResult> | CanonicalToolResult;
}>;

/**
 * Server-side provider boundary. Implementations rebuild bindings from current
 * permissions and live connection authority and keep every provider credential
 * inside the server process.
 */
export interface AppRuntimeToolProvider {
  resolve(
    input: Readonly<{
      authority: AppCurrentHumanAuthority;
      appId: string;
      releaseId?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<
    Readonly<{
      /** Digest of the authoritative canonical definitions, not display names. */
      catalogDigest: string;
      bindings: readonly AppRuntimeToolBinding[];
    }>
  >;
}

export async function projectAvailableAppRuntimeCatalog(
  input: Readonly<{
    authority: AppCurrentHumanAuthority;
    appId: string;
    provider: AppRuntimeToolProvider;
    signal?: AbortSignal;
  }>,
): Promise<AppAvailableRuntimeCatalogResponse> {
  const resolved = await input.provider.resolve({
    authority: input.authority,
    appId: input.appId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const tools = runtimeBindings(input.authority, resolved.bindings).map((binding) =>
    AppToolDescriptorSchema.parse(binding.descriptor),
  );
  return {
    appId: input.appId,
    catalogDigest: resolved.catalogDigest,
    tools: sortCanonicalToolDescriptors(tools),
  };
}

export class AppRuntimeCatalogDriftError extends Error {
  readonly code = "app_catalog_drift";
  constructor() {
    super("The App tool catalog changed after this release policy was created");
    this.name = "AppRuntimeCatalogDriftError";
  }
}

export class AppRuntimeToolUnavailableError extends Error {
  readonly code = "app_tool_unavailable";
  constructor() {
    super("The requested App tool is not currently available");
    this.name = "AppRuntimeToolUnavailableError";
  }
}

export class AppRuntimeCatalogMismatchError extends Error {
  readonly code = "app_catalog_mismatch";
  constructor() {
    super("The App used a stale runtime catalog");
    this.name = "AppRuntimeCatalogMismatchError";
  }
}

export async function projectAppRuntimeCatalog(
  input: Readonly<{
    authority: AppCurrentHumanAuthority;
    policy: AppRuntimePolicySnapshot;
    provider: AppRuntimeToolProvider;
    signal?: AbortSignal;
  }>,
): Promise<AppRuntimeCatalogResponse> {
  const resolved = await input.provider.resolve({
    authority: input.authority,
    appId: input.policy.appId,
    releaseId: input.policy.releaseId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (resolved.catalogDigest !== input.policy.catalogDigest) {
    throw new AppRuntimeCatalogDriftError();
  }
  const allowed = new Set(input.policy.allowedTools.map(canonicalToolIdentityKey));
  const tools = runtimeBindings(input.authority, resolved.bindings)
    .filter((binding) => allowed.has(canonicalToolIdentityKey(binding.descriptor.identity)))
    .map((binding) => AppToolDescriptorSchema.parse(binding.descriptor));
  return {
    appId: input.policy.appId,
    releaseId: input.policy.releaseId,
    toolPolicyRevisionId: input.policy.toolPolicyRevisionId,
    catalogDigest: input.policy.catalogDigest,
    tools: sortCanonicalToolDescriptors(tools),
  };
}

export async function callAppRuntimeTool(
  input: Readonly<{
    authority: AppCurrentHumanAuthority;
    policy: AppRuntimePolicySnapshot;
    request: AppRuntimeToolCallRequest;
    provider: AppRuntimeToolProvider;
    signal?: AbortSignal;
  }>,
): Promise<AppRuntimeToolCallResponse> {
  if (input.request.catalogDigest !== input.policy.catalogDigest) {
    throw new AppRuntimeCatalogMismatchError();
  }
  const resolved = await input.provider.resolve({
    authority: input.authority,
    appId: input.policy.appId,
    releaseId: input.policy.releaseId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (resolved.catalogDigest !== input.policy.catalogDigest) {
    throw new AppRuntimeCatalogDriftError();
  }
  const requestedIdentity = canonicalToolIdentityKey(input.request.identity);
  const allowed = new Set(input.policy.allowedTools.map(canonicalToolIdentityKey));
  const binding = runtimeBindings(input.authority, resolved.bindings).find(
    (candidate) => canonicalToolIdentityKey(candidate.descriptor.identity) === requestedIdentity,
  );
  if (!allowed.has(requestedIdentity) || !binding) throw new AppRuntimeToolUnavailableError();

  const validators = compileCanonicalToolSchemaValidators({
    inputSchema: binding.descriptor.inputSchema,
    ...(binding.descriptor.outputSchema ? { outputSchema: binding.descriptor.outputSchema } : {}),
  });
  assertCanonicalToolInput(validators.input, input.request.input);
  try {
    const result = await invokeCanonicalTool(
      binding.invoke,
      input.request.input,
      {
        operationId: input.request.operationId,
        caller: {
          authority: input.authority,
          appId: input.policy.appId,
          releaseId: input.policy.releaseId,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      },
      {
        timeoutMs: APP_RUNTIME_TOOL_TIMEOUT_MS,
        maxArgumentsBytes: APP_RUNTIME_TOOL_ARGUMENTS_MAX_BYTES,
        maxResultBytes: APP_RUNTIME_TOOL_RESULT_MAX_BYTES,
      },
    );
    const inspection = inspectCanonicalToolResult(result, {
      expectsStructured: Boolean(binding.descriptor.outputSchema),
      errorFallbackMessage: "The App tool failed",
    });
    if (inspection.kind === "error") {
      return {
        operationId: input.request.operationId,
        status: "failed",
        output: null,
        error: inspection.error,
        replayed: false,
      };
    }
    if (inspection.kind === "missing_structured") {
      throw new AppRuntimeToolUnavailableError();
    }
    if (inspection.kind === "structured") {
      if (validators.output) assertCanonicalToolOutput(validators.output, inspection.value);
      return {
        operationId: input.request.operationId,
        status: "succeeded",
        output: inspection.value,
        error: null,
        replayed: false,
      };
    }
    return {
      operationId: input.request.operationId,
      status: "succeeded",
      output: inspection.result,
      error: null,
      replayed: false,
    };
  } catch (error) {
    if (
      error instanceof AppRuntimeCatalogDriftError ||
      error instanceof AppRuntimeCatalogMismatchError ||
      error instanceof AppRuntimeToolUnavailableError
    ) {
      throw error;
    }
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "app_tool_failed";
    return {
      operationId: input.request.operationId,
      status: "failed",
      output: null,
      error: {
        code,
        message: "The App tool could not be completed",
        retryable: false,
      },
      replayed: false,
    };
  }
}

function runtimeBindings(
  authority: AppCurrentHumanAuthority,
  bindings: readonly AppRuntimeToolBinding[],
): AppRuntimeToolBinding[] {
  const eligible = bindings.filter(
    (binding) =>
      isCanonicalSafeReadToolEligible(binding.descriptor, "app") &&
      binding.descriptor.requiredPermissions.every((permission) =>
        hasPermission(authority.permissions, permission),
      ),
  );
  const sorted = sortCanonicalToolDescriptors(eligible.map((binding) => binding.descriptor));
  const byIdentity = new Map(
    eligible.map((binding) => [canonicalToolIdentityKey(binding.descriptor.identity), binding]),
  );
  return sorted.map((descriptor) => byIdentity.get(canonicalToolIdentityKey(descriptor.identity))!);
}
