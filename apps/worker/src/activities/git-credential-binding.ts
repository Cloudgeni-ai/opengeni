import type { Settings } from "@opengeni/config";
import {
  GitCredentialRepositoryRef as GitCredentialRepositoryRefContract,
  RebindGitCredentialsResult,
  type ConnectionCredentialsPort,
  type GitCredentialProvider,
  type GitCredentialRepositoryRef,
  type GitHubRepository,
  type ObservedGitRepositoryIdentity,
} from "@opengeni/contracts";
import {
  listGitHubInstallationIdsForWorkspace,
  listSandboxGitCredentialBindings,
  markSandboxGitCredentialBindingsStatus,
  upsertSandboxGitCredentialBinding,
  withActiveSandboxGitCredentialBindings,
  type Database,
  type SandboxGitCredentialBinding,
  type SandboxGitCredentialBindingStatus,
} from "@opengeni/db";
import { listGitHubAppRepositories } from "@opengeni/github";
import {
  SandboxChannelAService,
  installGitCredentialHelpersAndTokens,
  invalidateGitProviderTokenFiles,
  refreshGitProviderTokenFiles,
  type SandboxLifecycleCommandRunner,
  type GitCredentialTokenWriterSession,
} from "@opengeni/runtime";
import {
  gitCredentialRepositoryRefs,
  mintRunGitCredentialsFromRepositoryRefs,
  type ConnectionScope,
  type MintedRunGitCredentials,
} from "./environment";
import type { ResourceRef } from "@opengeni/contracts";
import {
  assertExplicitCredentialRepositoryRef,
  repositoryIdentityForCredentialRef,
} from "./git-credential-identity";

export {
  assertCredentialRepositoryRefSecretFree,
  repositoryIdentityForCredentialRef,
} from "./git-credential-identity";

type FailureStatus = "not_found" | "ambiguous" | "unavailable" | "revoked";

export type GitCredentialLifecycleErrorCode =
  | "authorization_unproven"
  | "binding_resolution_failed"
  | "binding_fence_rejected"
  | "token_mint_failed"
  | "token_install_failed"
  | "token_refresh_failed"
  | "token_invalidation_failed"
  | "token_cleanup_failed";

/** Fixed, secret-safe controller failure surfaced across worker/runtime seams. */
export class GitCredentialLifecycleError extends Error {
  override readonly name = "GitCredentialLifecycleError";

  constructor(readonly code: GitCredentialLifecycleErrorCode) {
    super(`Git credential lifecycle failed (${code})`);
  }
}

export type ResolvedGitCredentialBinding = {
  status: "bound";
  repositoryRefs: GitCredentialRepositoryRef[];
  bindings: SandboxGitCredentialBinding[];
  expectedGenerations: Partial<Record<GitCredentialProvider, number>>;
};

export type UnresolvedGitCredentialBinding = {
  status: FailureStatus;
  providers: GitCredentialProvider[];
  reasonCode: string;
  /** Providers with a legacy token file but no durable row to fence its removal. */
  legacyInvalidationProviders?: GitCredentialProvider[];
};

export type GitCredentialBindingResolution =
  | ResolvedGitCredentialBinding
  | UnresolvedGitCredentialBinding;

export type ResolveGitCredentialBindingOptions = {
  db: Database;
  settings: Settings;
  scope: ConnectionScope & { sessionId: string };
  session: GitCredentialTokenWriterSession;
  resources: readonly ResourceRef[];
  connectionCredentials?: ConnectionCredentialsPort | null;
  runAs?: string;
  commandRunner?: SandboxLifecycleCommandRunner;
  listGitHubRepositories?: (
    settings: Settings,
    input: { installationIds?: number[] },
  ) => Promise<GitHubRepository[]>;
  /** Narrow dependency seams for deterministic resolver tests. */
  operations?: {
    listBindings?: typeof listSandboxGitCredentialBindings;
    upsertBinding?: typeof upsertSandboxGitCredentialBinding;
    markBindingsStatus?: typeof markSandboxGitCredentialBindingsStatus;
    listGitHubInstallationIds?: typeof listGitHubInstallationIdsForWorkspace;
    detectRepositories?: (
      session: GitCredentialTokenWriterSession,
      runAs?: string,
    ) => Promise<Awaited<ReturnType<SandboxChannelAService["detectGitRepositoryIdentities"]>>>;
  };
};

function withLegacyInvalidationProviders(
  resolution: UnresolvedGitCredentialBinding,
  bindings: readonly SandboxGitCredentialBinding[],
): UnresolvedGitCredentialBinding {
  const durableProviders = new Set(bindings.map((binding) => binding.provider));
  const legacyInvalidationProviders = resolution.providers.filter(
    (provider) => !durableProviders.has(provider),
  );
  return legacyInvalidationProviders.length > 0
    ? { ...resolution, legacyInvalidationProviders }
    : resolution;
}

function identityKey(identity: ObservedGitRepositoryIdentity): string {
  return `${identity.provider}:${identity.canonical.toLowerCase()}`;
}

export function validateReboundCredentialRefs(
  refs: readonly GitCredentialRepositoryRef[],
  observed: readonly ObservedGitRepositoryIdentity[],
): GitCredentialRepositoryRef[] {
  const parsed = GitCredentialRepositoryRefContract.array().min(1).parse(refs);
  const observedKeys = new Set(observed.map(identityKey));
  const reboundKeys = new Set(
    parsed.map((ref) => identityKey(repositoryIdentityForCredentialRef(ref))),
  );
  if (
    observedKeys.size !== reboundKeys.size ||
    [...observedKeys].some((key) => !reboundKeys.has(key))
  ) {
    throw new Error("credential rebind did not exactly cover the observed repositories");
  }
  return [...parsed].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

export type ValidatedRebindGitCredentialsResult =
  | { status: "bound"; repositoryRefs: GitCredentialRepositoryRef[] }
  | UnresolvedGitCredentialBinding;

/** Parse the host result, enforce its workspace echo, and prove exact coverage. */
export function validateRebindGitCredentialsResult(
  workspaceId: string,
  observed: readonly ObservedGitRepositoryIdentity[],
  value: unknown,
): ValidatedRebindGitCredentialsResult {
  const result = RebindGitCredentialsResult.parse(value);
  if (result.workspaceId !== workspaceId) {
    throw new Error(
      `connection-credential provider (rebindGitCredentials) scoped to workspace ${result.workspaceId} but the run is workspace ${workspaceId}`,
    );
  }
  const providers = [...new Set(observed.map((repository) => repository.provider))].sort();
  if (result.status !== "bound") {
    return {
      status: result.status,
      providers,
      reasonCode: result.reasonCode ?? `host_${result.status}`,
    };
  }
  return {
    status: "bound",
    repositoryRefs: validateReboundCredentialRefs(result.repositoryRefs, observed),
  };
}

export type GitHubCatalogBindingMatch =
  | { status: "bound"; repositoryRefs: GitCredentialRepositoryRef[] }
  | { status: "not_found" | "ambiguous"; reasonCode: string };

export function matchObservedGitHubRepositories(
  observed: readonly ObservedGitRepositoryIdentity[],
  repositories: readonly GitHubRepository[],
): GitHubCatalogBindingMatch {
  const refs: GitCredentialRepositoryRef[] = [];
  for (const repository of observed) {
    if (repository.provider !== "github") {
      return { status: "not_found", reasonCode: "provider_not_in_github_catalog" };
    }
    const matches = repositories.filter(
      (candidate) =>
        `github.com/${candidate.fullName}`.toLowerCase() === repository.canonical.toLowerCase(),
    );
    if (matches.length === 0) {
      return { status: "not_found", reasonCode: "repository_not_authorized" };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", reasonCode: "repository_match_ambiguous" };
    }
    const match = matches[0]!;
    refs.push({
      provider: "github",
      uri: match.cloneUrl,
      ref: match.defaultBranch,
      repositoryId: match.id,
      installationId: match.installationId,
    });
  }
  return {
    status: "bound",
    repositoryRefs: validateReboundCredentialRefs(refs, observed),
  };
}

function groupRefsByProvider(
  refs: readonly GitCredentialRepositoryRef[],
): Map<GitCredentialProvider, GitCredentialRepositoryRef[]> {
  const grouped = new Map<GitCredentialProvider, GitCredentialRepositoryRef[]>();
  for (const ref of refs) {
    if (!ref.provider) throw new Error("Git credential repository ref omitted provider");
    const values = grouped.get(ref.provider) ?? [];
    values.push(ref);
    grouped.set(ref.provider, values);
  }
  return grouped;
}

function boundResolution(bindings: SandboxGitCredentialBinding[]): ResolvedGitCredentialBinding {
  const repositoryRefs = bindings.flatMap((binding) => binding.repositoryRefs);
  const expectedGenerations: Partial<Record<GitCredentialProvider, number>> = {};
  for (const binding of bindings) expectedGenerations[binding.provider] = binding.generation;
  return { status: "bound", repositoryRefs, bindings, expectedGenerations };
}

async function persistRefs(
  options: ResolveGitCredentialBindingOptions,
  refs: readonly GitCredentialRepositoryRef[],
  source: "explicit_resource" | "observed_checkout",
): Promise<ResolvedGitCredentialBinding> {
  const bindings: SandboxGitCredentialBinding[] = [];
  const upsertBinding = options.operations?.upsertBinding ?? upsertSandboxGitCredentialBinding;
  for (const [provider, repositoryRefs] of [...groupRefsByProvider(refs)].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    bindings.push(
      await upsertBinding(options.db, {
        ...options.scope,
        provider,
        source,
        repositoryRefs,
      }),
    );
  }
  return boundResolution(bindings);
}

async function deactivateBindings(
  options: ResolveGitCredentialBindingOptions,
  bindings: readonly SandboxGitCredentialBinding[],
  providers: readonly GitCredentialProvider[],
  status: Exclude<SandboxGitCredentialBindingStatus, "active">,
  reasonCode: string,
): Promise<void> {
  // Only the active rows in the exact snapshot this resolver inspected may be
  // deactivated. A concurrent resolver/rebinder that advances one generation
  // owns the replacement and must not have its token removed by this stale
  // controller.
  const active = new Map(
    bindings
      .filter((binding) => binding.status === "active")
      .map((binding) => [binding.provider, binding] as const),
  );
  const selected = [...new Set(providers)].filter((provider) => active.has(provider)).sort();
  if (selected.length === 0) return;
  const expectedGenerations: Partial<Record<GitCredentialProvider, number>> = {};
  for (const provider of selected) {
    expectedGenerations[provider] = active.get(provider)!.generation;
  }
  const markBindingsStatus =
    options.operations?.markBindingsStatus ?? markSandboxGitCredentialBindingsStatus;
  await markBindingsStatus(options.db, {
    ...options.scope,
    providers: selected,
    status,
    reasonCode,
    expectedGenerations,
    mutateSandbox: async () => {
      await invalidateGitProviderTokenFiles(options.session, selected, {
        ...(options.runAs ? { runAs: options.runAs } : {}),
        ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
      });
    },
  });
}

function bindingRefsExactlyCover(
  bindings: readonly SandboxGitCredentialBinding[],
  observed: readonly ObservedGitRepositoryIdentity[],
): boolean {
  if (bindings.length === 0 || bindings.some((binding) => binding.status !== "active")) {
    return false;
  }
  try {
    validateReboundCredentialRefs(
      bindings.flatMap((binding) => binding.repositoryRefs),
      observed,
    );
    return true;
  } catch {
    return false;
  }
}

async function standaloneRebind(
  options: ResolveGitCredentialBindingOptions,
  observed: readonly ObservedGitRepositoryIdentity[],
): Promise<GitCredentialBindingResolution> {
  const providers = [...new Set(observed.map((repository) => repository.provider))].sort();
  if (providers.some((provider) => provider !== "github")) {
    return { status: "unavailable", providers, reasonCode: "provider_rebind_unavailable" };
  }
  const listInstallationIds =
    options.operations?.listGitHubInstallationIds ?? listGitHubInstallationIdsForWorkspace;
  const installationIds = await listInstallationIds(options.db, options.scope.workspaceId);
  if (installationIds.length === 0) {
    return { status: "not_found", providers, reasonCode: "no_workspace_installation" };
  }
  let repositories: GitHubRepository[];
  try {
    repositories = await (options.listGitHubRepositories ?? listGitHubAppRepositories)(
      options.settings,
      { installationIds },
    );
  } catch {
    return { status: "unavailable", providers, reasonCode: "catalog_unavailable" };
  }
  let match: GitHubCatalogBindingMatch;
  try {
    match = matchObservedGitHubRepositories(observed, repositories);
  } catch {
    return { status: "unavailable", providers, reasonCode: "catalog_response_invalid" };
  }
  if (match.status !== "bound") {
    return { ...match, providers };
  }
  return await persistRefs(options, match.repositoryRefs, "observed_checkout");
}

export async function resolveGitCredentialBindingForSession(
  options: ResolveGitCredentialBindingOptions,
): Promise<GitCredentialBindingResolution> {
  const listBindings = options.operations?.listBindings ?? listSandboxGitCredentialBindings;
  const existing = await listBindings(
    options.db,
    options.scope.workspaceId,
    options.scope.sessionId,
  );
  const explicitRefs = gitCredentialRepositoryRefs(options.resources);
  if (explicitRefs.length > 0) {
    // Resource attachments were already authorized by the API. Persist only the
    // provider/catalog shape used by the existing mint path.
    for (const ref of explicitRefs) assertExplicitCredentialRepositoryRef(ref);
    const resolution = await persistRefs(options, explicitRefs, "explicit_resource");
    const currentProviders = new Set(resolution.bindings.map((binding) => binding.provider));
    await deactivateBindings(
      options,
      existing,
      existing
        .map((binding) => binding.provider)
        .filter((provider) => !currentProviders.has(provider)),
      "rebind_required",
      "repository_not_observed",
    );
    return resolution;
  }

  const discovery = options.operations?.detectRepositories
    ? await options.operations.detectRepositories(options.session, options.runAs)
    : await new SandboxChannelAService({
        session: options.session,
        ...(options.runAs ? { runAs: options.runAs } : {}),
      }).detectGitRepositoryIdentities();
  const existingProviders = [...new Set(existing.map((binding) => binding.provider))].sort();
  if (!discovery.complete) {
    await deactivateBindings(
      options,
      existing,
      existingProviders,
      "unavailable",
      "discovery_incomplete",
    );
    return {
      status: "unavailable",
      providers: existingProviders,
      reasonCode: "discovery_incomplete",
    };
  }
  if (discovery.repositories.length === 0) {
    await deactivateBindings(
      options,
      existing,
      existingProviders,
      "rebind_required",
      "no_repository_observed",
    );
    return {
      status: "not_found",
      providers: existingProviders,
      reasonCode: "no_repository_observed",
    };
  }

  const observedProviders = [
    ...new Set(discovery.repositories.map((repository) => repository.provider)),
  ].sort();
  await deactivateBindings(
    options,
    existing,
    existingProviders.filter((provider) => !observedProviders.includes(provider)),
    "rebind_required",
    "repository_not_observed",
  );
  const durable = existing.filter((binding) => observedProviders.includes(binding.provider));
  if (bindingRefsExactlyCover(durable, discovery.repositories)) {
    return boundResolution(durable);
  }
  const port = options.connectionCredentials?.rebindGitCredentials;
  if (!port) {
    const standalone = await standaloneRebind(options, discovery.repositories);
    if (standalone.status === "bound") return standalone;
    await deactivateBindings(
      options,
      durable,
      observedProviders,
      standalone.status === "unavailable" ? "unavailable" : "rebind_required",
      standalone.reasonCode,
    );
    return withLegacyInvalidationProviders(standalone, durable);
  }

  let hostResult: unknown;
  try {
    hostResult = await port({
      accountId: options.scope.accountId,
      workspaceId: options.scope.workspaceId,
      repositories: discovery.repositories,
    });
  } catch {
    hostResult = {
      status: "unavailable",
      workspaceId: options.scope.workspaceId,
      reasonCode: "host_call_failed",
    };
  }
  let result: ValidatedRebindGitCredentialsResult;
  try {
    result = validateRebindGitCredentialsResult(
      options.scope.workspaceId,
      discovery.repositories,
      hostResult,
    );
  } catch {
    result = {
      status: "unavailable",
      providers: observedProviders,
      reasonCode: "host_response_invalid",
    };
  }
  if (result.status !== "bound") {
    await deactivateBindings(
      options,
      durable,
      observedProviders,
      result.status === "revoked"
        ? "revoked"
        : result.status === "unavailable"
          ? "unavailable"
          : "rebind_required",
      result.reasonCode,
    );
    return withLegacyInvalidationProviders(result, durable);
  }
  return await persistRefs(options, result.repositoryRefs, "observed_checkout");
}

export async function mintResolvedGitCredentialBinding(
  settings: Settings,
  scope: ConnectionScope,
  binding: ResolvedGitCredentialBinding,
  gitCredentials?: ConnectionCredentialsPort["gitCredentials"],
): Promise<MintedRunGitCredentials | undefined> {
  return await mintRunGitCredentialsFromRepositoryRefs(settings, binding.repositoryRefs, {
    scope,
    ...(gitCredentials ? { gitCredentials } : {}),
  });
}

/** Require one non-empty token for every provider authorized by the binding. */
export function assertMintedGitCredentialBindingCoverage(
  binding: ResolvedGitCredentialBinding,
  minted: MintedRunGitCredentials | undefined,
): MintedRunGitCredentials {
  if (!minted) {
    throw new GitCredentialLifecycleError("token_mint_failed");
  }
  for (const provider of Object.keys(binding.expectedGenerations) as GitCredentialProvider[]) {
    if (!minted.gitTokens[provider]) {
      throw new GitCredentialLifecycleError("token_mint_failed");
    }
  }
  return minted;
}

export async function installResolvedGitCredentialBinding(
  db: Database,
  scope: ConnectionScope & { sessionId: string },
  session: GitCredentialTokenWriterSession,
  binding: ResolvedGitCredentialBinding,
  minted: MintedRunGitCredentials,
  options: { runAs?: string; commandRunner?: SandboxLifecycleCommandRunner } = {},
): Promise<void> {
  let result: Awaited<ReturnType<typeof withActiveSandboxGitCredentialBindings>>;
  try {
    result = await withActiveSandboxGitCredentialBindings(
      db,
      { ...scope, expectedGenerations: binding.expectedGenerations },
      async () => {
        await installGitCredentialHelpersAndTokens(
          session,
          binding.repositoryRefs,
          minted.gitTokens,
          options,
        );
      },
    );
  } catch {
    throw new GitCredentialLifecycleError("token_install_failed");
  }
  if (!result.applied) {
    throw new GitCredentialLifecycleError("binding_fence_rejected");
  }
}

export async function refreshResolvedGitCredentialBinding(
  db: Database,
  scope: ConnectionScope & { sessionId: string },
  session: GitCredentialTokenWriterSession,
  binding: ResolvedGitCredentialBinding,
  minted: MintedRunGitCredentials,
  options: { runAs?: string; commandRunner?: SandboxLifecycleCommandRunner } = {},
): Promise<void> {
  let result: Awaited<ReturnType<typeof withActiveSandboxGitCredentialBindings>>;
  try {
    result = await withActiveSandboxGitCredentialBindings(
      db,
      { ...scope, expectedGenerations: binding.expectedGenerations },
      async () => {
        await refreshGitProviderTokenFiles(session, minted.gitTokens, options);
      },
    );
  } catch {
    throw new GitCredentialLifecycleError("token_refresh_failed");
  }
  if (!result.applied) {
    throw new GitCredentialLifecycleError("binding_fence_rejected");
  }
}

export async function expireResolvedGitCredentialBinding(
  db: Database,
  scope: ConnectionScope & { sessionId: string },
  session: GitCredentialTokenWriterSession,
  binding: ResolvedGitCredentialBinding,
  providers: readonly GitCredentialProvider[],
  options: { runAs?: string; commandRunner?: SandboxLifecycleCommandRunner } = {},
): Promise<void> {
  let result: Awaited<ReturnType<typeof withActiveSandboxGitCredentialBindings>>;
  try {
    result = await withActiveSandboxGitCredentialBindings(
      db,
      { ...scope, expectedGenerations: binding.expectedGenerations },
      async () => {
        await invalidateGitProviderTokenFiles(session, providers, options);
      },
    );
  } catch {
    throw new GitCredentialLifecycleError("token_invalidation_failed");
  }
  // A stale/revoked binding must never authorize a file mutation. Its revoker
  // owns invalidation under the replacement generation/status lock.
  if (!result.applied && result.reason === "missing") {
    throw new GitCredentialLifecycleError("binding_fence_rejected");
  }
}

export async function invalidateResolvedGitCredentialBinding(
  db: Database,
  scope: ConnectionScope & { sessionId: string },
  session: GitCredentialTokenWriterSession,
  binding: ResolvedGitCredentialBinding,
  input: {
    status: Exclude<SandboxGitCredentialBindingStatus, "active">;
    reasonCode: string;
    runAs?: string;
    commandRunner?: SandboxLifecycleCommandRunner;
  },
): Promise<void> {
  const providers = Object.keys(binding.expectedGenerations).sort() as GitCredentialProvider[];
  let rows: Awaited<ReturnType<typeof markSandboxGitCredentialBindingsStatus>>;
  try {
    rows = await markSandboxGitCredentialBindingsStatus(db, {
      ...scope,
      providers,
      status: input.status,
      reasonCode: input.reasonCode,
      expectedGenerations: binding.expectedGenerations,
      mutateSandbox: async () => {
        await invalidateGitProviderTokenFiles(session, providers, {
          ...(input.runAs ? { runAs: input.runAs } : {}),
          ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
        });
      },
    });
  } catch {
    throw new GitCredentialLifecycleError("token_invalidation_failed");
  }
  if (rows.length !== providers.length) {
    throw new GitCredentialLifecycleError("binding_fence_rejected");
  }
}
