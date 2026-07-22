import {
  applyGitAuthPointerEnvironment,
  firstPartyMcpWorkspaceUrl,
  stableSandboxEnvironmentForRun,
  type Settings,
} from "@opengeni/config";
import {
  gitCredentialBindingIdForRepository,
  gitCredentialProviderForRepository,
  signDelegatedAccessToken,
  type ConnectionCredentialsPort,
  type GitCredentialProvider,
  type GitCredentialRepositoryRef,
  type GitCredentials,
  type ResourceRef,
  type SandboxSecrets,
  type SessionTurn,
  type TurnInitiator,
  type TurnInitiatorContext,
} from "@opengeni/contracts";
import {
  loadVariableSetForRun as loadWorkspaceEnvironmentForRunFromDb,
  type Database,
  type VariableSetForRun as WorkspaceEnvironmentForRun,
} from "@opengeni/db";
import { createGitHubAppInstallationTokenWithExpiry, githubAppBotIdentity } from "@opengeni/github";

// Re-exported from the shared @opengeni/db leaf (moved there so the API-direct
// attach paths can load the SAME decrypted workspace environment the turn
// declares — keeping the box-manifest env and agent-manifest env identical).
// Existing worker import sites (agent-turn) continue importing from here.
export {
  loadWorkspaceEnvironmentForRunFromDb as loadWorkspaceEnvironmentForRun,
  type WorkspaceEnvironmentForRun,
};

// §7.6 connection-credential provider — the run's workspace identity, threaded so the connection-credential
// provider can be called with the run's tenant context AND so the workspace-scope cross-check
// cross-check has the run's workspace to assert the provider's echo against.
export type ConnectionScope = {
  accountId: string;
  workspaceId: string;
};

export type GitTokenSeeds = Partial<Record<GitCredentialProvider, string>>;
export type GitTokenExpiries = Partial<Record<GitCredentialProvider, string>>;
export type GitCredentialBindingSeed = {
  credentialBindingId: string;
  provider: GitCredentialProvider;
  token: string;
  expiresAt?: string;
  providerBindingCount?: number;
};
export type MintedRunGitCredentials = {
  bindings: GitCredentialBindingSeed[];
  // Compatibility views exist only when a provider has exactly one binding.
  // A multi-binding provider intentionally has no provider-level alias.
  gitTokens: GitTokenSeeds;
  expiresAt: GitTokenExpiries;
};

export type GitHubTokenMintAuthorization = (selection: {
  installationId: number;
  repositoryIds: number[];
}) => Promise<void>;

export const TOOLSPACE_TOKEN_TTL_SECONDS = 60 * 60;

export type MintedSandboxToolspaceToken = {
  token: string;
  expiresAt: Date;
};

export async function mintSandboxToolspaceToken(
  settings: Settings,
  scope: ConnectionScope,
  sessionId: string,
  runId: string,
  nowMs = Date.now(),
): Promise<MintedSandboxToolspaceToken | undefined> {
  if (!settings.toolspaceEnabled || !settings.delegationSecret) {
    return undefined;
  }
  const expiresAtSeconds = Math.floor(nowMs / 1000) + TOOLSPACE_TOKEN_TTL_SECONDS;
  const token = await signDelegatedAccessToken(settings.delegationSecret, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: `sandbox:${runId}`,
    subjectLabel: "sandbox toolspace",
    permissions: ["toolspace:call"],
    sessionId,
    exp: expiresAtSeconds,
  });
  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
}

export type GitCredentialAuthority = {
  sessionId: string;
  rootSessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  initiator: TurnInitiator;
  initiatorContext: TurnInitiatorContext;
};

export function gitCredentialAuthorityForTurn(input: {
  sessionId: string;
  rootSessionId: string;
  attemptId: string;
  turn: Pick<SessionTurn, "id" | "executionGeneration" | "initiator" | "initiatorContext">;
}): GitCredentialAuthority {
  return {
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId,
    turnId: input.turn.id,
    attemptId: input.attemptId,
    executionGeneration: input.turn.executionGeneration,
    initiator: input.turn.initiator,
    initiatorContext: input.turn.initiatorContext,
  };
}

type RunGitCredentialOptions = {
  scope?: ConnectionScope;
  authority?: GitCredentialAuthority;
  gitCredentials?: ConnectionCredentialsPort["gitCredentials"];
  authorizeGitHubTokenMint?: GitHubTokenMintAuthorization;
};

// §7.6 connection-credential provider — load the run's workspace environment, delegating the DECRYPT to a
// host `sandboxSecrets` provider when one is bound (the host owns the secret
// vault + encryption key in embedded/separate topologies) and otherwise running
// today's local `environmentsEncryptionKeyBytes`-keyed decrypt byte-for-byte.
//
// Unattached runs (environmentId === null) short-circuit identically in BOTH
// modes: zero DB/provider work, returns null. When a provider IS bound it owns
// the decrypt end-to-end (it reads the host's own store), so the local DB read
// is skipped — the provider is the sole source of truth for that leg.
export async function loadWorkspaceEnvironmentForRunWithCredentials(
  db: Database,
  settings: Settings,
  scope: ConnectionScope,
  environmentId: string | null,
  sandboxSecrets?: ConnectionCredentialsPort["sandboxSecrets"],
): Promise<WorkspaceEnvironmentForRun | null> {
  if (!sandboxSecrets) {
    // Standalone default: today's local decrypt, unchanged.
    return loadWorkspaceEnvironmentForRunFromDb(db, settings, scope.workspaceId, environmentId);
  }
  if (!environmentId) {
    return null;
  }
  const secrets: SandboxSecrets = await sandboxSecrets({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    variableSetId: environmentId,
  });
  // workspace-scope cross-check: the provider must echo THIS run's workspace before we apply its
  // decrypted values into the sandbox.
  assertWorkspaceEcho("sandboxSecrets", scope, secrets.workspaceId);
  return {
    id: secrets.id ?? environmentId,
    name: secrets.name ?? environmentId,
    description: secrets.description ?? null,
    values: secrets.values,
  };
}

// Workspace-scope cross-check. A credential provider echoes the workspace it scoped
// the credential to; we ASSERT it equals the run's workspace BEFORE the caller
// injects the credential. A host mapping bug returning tenant B's creds for a
// tenant-A run hard-throws here instead of landing tenant B's token in tenant
// A's sandbox. Account/workspace ids only in the message (never the credential).
function assertWorkspaceEcho(
  kind: string,
  scope: ConnectionScope,
  echoedWorkspaceId: string,
): void {
  if (echoedWorkspaceId !== scope.workspaceId) {
    throw new Error(
      `connection-credential provider (${kind}) scoped to workspace ${echoedWorkspaceId} but the run is workspace ${scope.workspaceId}`,
    );
  }
}

export async function sandboxEnvironmentForRun(
  settings: Settings,
  resources: ResourceRef[],
  workspaceEnvironment: Record<string, string> = {},
  // §7.6 connection-credential provider - optional host git-credential provider + the run scope it needs
  // (unset, the standalone default → self-mint from `settings` byte-for-byte).
  // `skipGitHubToken` (Stage D): a connected-machine turn skips the inert platform
  // token mint entirely and returns the stable base env unchanged. `deferGitHubToken`
  // is the lazy CLOUD path: apply stable git-auth pointers now, mint only the token
  // value later. `= {}` default so the non-optional reads below are safe.
  options: RunGitCredentialOptions & {
    skipGitHubToken?: boolean;
    deferGitHubToken?: boolean;
    sessionId?: string;
    runId?: string;
  } = {},
): Promise<{
  environment: Record<string, string>;
  gitToken?: string;
  gitTokens?: GitTokenSeeds;
  gitTokenExpiresAt?: GitTokenExpiries;
  gitCredentialBindings?: GitCredentialBindingSeed[];
  toolspaceToken?: string;
  toolspaceTokenExpiresAt?: Date;
}> {
  // Precedence: deployment allowlist < git identity < workspace environment
  // < backend-aware HOME (the STABLE base, shared with the API-direct attach
  // paths via stableSandboxEnvironmentForRun) < platform run-scoped git auth
  // (applied below, always last). Reserved name validation at write time prevents
  // workspace values from colliding with the platform-managed entries.
  //
  // TOKEN-BROKER (B1): run-scoped git provider tokens are NO LONGER layered into
  // the box/agent MANIFEST env (no GH_TOKEN/GITHUB_TOKEN/GITLAB_TOKEN/
  // AZURE_DEVOPS_EXT_PAT/GIT_CONFIG_* extraheader). They are minted once per turn
  // and returned separately as provider token seeds; the caller threads them
  // OFF-MANIFEST as clone-seed exec env vars so the clone hook writes stable token
  // files. The manifest carries only stable pointers (GIT_ASKPASS,
  // GIT_TERMINAL_PROMPT, identity, OPENGENI_GIT_CREDENTIALS_DIR, and
  // OPENGENI_GIT_TOKEN_FILE), so token VALUES never ride the manifest and the SDK's
  // per-turn provided-session env delta stays empty even though tokens rotate.
  // GitHub keeps the legacy `gitToken`/OPENGENI_GIT_TOKEN_FILE alias. The worker
  // proactively renews every selected provider behind these stable pointers.
  const stableOptions = options.scope ? { workspaceId: options.scope.workspaceId } : {};
  const environment = stableSandboxEnvironmentForRun(settings, workspaceEnvironment, stableOptions);
  // TOOLSPACE (selfhosted parity): the toolspace token is minted for EVERY
  // backend, including a connected machine. Unlike platform git provider tokens
  // (inert on selfhosted → skipped above), the toolspace token is the machine's
  // only path to programmatic tool calling, and it grants no more than the
  // machine owner's own authority (toolspace:call, own-session-bound, turn TTL,
  // budgeted, approval-tools excluded). Delivery mirrors the docker path: the
  // caller threads it OFF-MANIFEST as the seed the runtime writes to
  // $OPENGENI_TOOLSPACE_TOKEN_FILE over the box's exec channel.
  const toolspaceScope = options.scope;
  const toolspaceToken =
    toolspaceScope && options.sessionId && options.runId
      ? await mintSandboxToolspaceToken(settings, toolspaceScope, options.sessionId, options.runId)
      : undefined;
  if (toolspaceToken && toolspaceScope) {
    environment.OPENGENI_TOOLSPACE_URL ??= firstPartyMcpWorkspaceUrl(
      settings,
      toolspaceScope.workspaceId,
    );
  }
  const selections = gitCredentialSelections(resources);
  // NO-TOKEN SKIP (Stage D, change B): when the turn's EFFECTIVE compute backend is
  // a connected machine (selfhosted), platform git provider tokens are INERT: exec
  // routes over NATS to the user's machine, which uses ITS OWN git credentials, and
  // the box those tokens would auth is never created. So skip the token mint entirely
  // and return the STABLE base env (no gitToken/gitTokens). Env-
  // parity holds: the SAME base object still feeds buildManifest + the SelfhostedSession
  // manifest, so the SDK's per-turn provided-session env delta stays empty
  // (validateNoEnvironmentDelta). The API-direct viewer attach path already drops the
  // token under this exact contract — proof a box runs fine without it.
  if (selections.length === 0 || options.skipGitHubToken) {
    return {
      environment,
      ...(toolspaceToken
        ? {
            toolspaceToken: toolspaceToken.token,
            toolspaceTokenExpiresAt: toolspaceToken.expiresAt,
          }
        : {}),
    };
  }
  if (options.deferGitHubToken) {
    applyGitAuthPointerEnvironment(
      environment,
      await resolveRunGitIdentityWithSelections(settings, selections, options),
    );
    return {
      environment,
      ...(toolspaceToken
        ? {
            toolspaceToken: toolspaceToken.token,
            toolspaceTokenExpiresAt: toolspaceToken.expiresAt,
          }
        : {}),
    };
  }
  // Run-scoped sandbox preparation for repository resources. GitHub retains the
  // legacy request shape and standalone self-mint path. Non-GitHub providers are
  // host-brokered only: without a `gitCredentials` port there is no token value
  // to seed, and the runtime wrappers degrade to passthrough.
  const minted = await mintRunGitTokensWithIdentity(settings, selections, options);
  // TOKEN-BROKER (B2): the askpass helper is PROVISIONED AT SETUP (runtime) into a
  // per-box, user-writable path in the SAME dir as the token file, instead of a
  // baked image script at /usr/local/bin/opengeni-git-askpass. The clone-hook seed
  // block writes both the token file AND this askpass script before the fetch, so
  // git auth becomes correct on ANY box image (including pre-existing warm boxes on
  // their next turn's clone hook) — no product image needs to carry the askpass.
  // The pointer layer is the SHARED config helper so every API-direct attach
  // surface (viewer attach, channel-A) declares the IDENTICAL env when it
  // cold-creates the box for a repo-attached session — an attach-warmed box
  // missing these keys kills the next repo turn on the SDK's manifest-env guard.
  applyGitAuthPointerEnvironment(environment, minted.identity);
  return {
    environment,
    ...(minted.gitTokens.github ? { gitToken: minted.gitTokens.github } : {}),
    ...(Object.keys(minted.gitTokens).length > 0 ? { gitTokens: minted.gitTokens } : {}),
    ...(Object.keys(minted.expiresAt).length > 0 ? { gitTokenExpiresAt: minted.expiresAt } : {}),
    ...(minted.bindings.length > 0 ? { gitCredentialBindings: minted.bindings } : {}),
    ...(toolspaceToken
      ? {
          toolspaceToken: toolspaceToken.token,
          toolspaceTokenExpiresAt: toolspaceToken.expiresAt,
        }
      : {}),
  };
}

export async function mintRunGitCredentials(
  settings: Settings,
  resources: ResourceRef[],
  options: RunGitCredentialOptions = {},
): Promise<MintedRunGitCredentials | undefined> {
  const selections = gitCredentialSelections(resources);
  if (selections.length === 0) {
    return undefined;
  }
  const minted = await mintRunGitTokensWithIdentity(settings, selections, options);
  return minted.bindings.length > 0
    ? { bindings: minted.bindings, gitTokens: minted.gitTokens, expiresAt: minted.expiresAt }
    : undefined;
}

export async function mintRunGitCredentialBinding(
  settings: Settings,
  resources: ResourceRef[],
  provider: GitCredentialProvider,
  credentialBindingId: string,
  options: RunGitCredentialOptions = {},
): Promise<GitCredentialBindingSeed | undefined> {
  const selections = gitCredentialSelections(resources);
  const selection = selections.find(
    (candidate) =>
      candidate.provider === provider && candidate.credentialBindingId === credentialBindingId,
  );
  if (!selection) {
    return undefined;
  }
  const minted = await mintRunGitTokensWithIdentity(settings, [selection], options);
  const binding = minted.bindings[0];
  if (binding) {
    binding.providerBindingCount = selections.filter(
      (candidate) => candidate.provider === selection.provider,
    ).length;
  }
  return binding;
}

export async function mintRunGitTokens(
  settings: Settings,
  resources: ResourceRef[],
  options: RunGitCredentialOptions = {},
): Promise<GitTokenSeeds | undefined> {
  const tokens = (await mintRunGitCredentials(settings, resources, options))?.gitTokens;
  return tokens && Object.keys(tokens).length > 0 ? tokens : undefined;
}

export async function mintRunGitToken(
  settings: Settings,
  resources: ResourceRef[],
  options: RunGitCredentialOptions = {},
): Promise<string | undefined> {
  return (await mintRunGitTokens(settings, resources, options))?.github;
}

export async function resolveRunGitIdentity(
  settings: Settings,
  resources: ResourceRef[],
  options: RunGitCredentialOptions = {},
): Promise<{ name: string; email: string } | null> {
  const selections = gitCredentialSelections(resources);
  if (selections.length === 0) {
    return null;
  }
  return await resolveRunGitIdentityWithSelections(settings, selections, options);
}

async function mintRunGitTokensWithIdentity(
  settings: Settings,
  selections: GitCredentialSelection[],
  options: RunGitCredentialOptions,
): Promise<{
  bindings: GitCredentialBindingSeed[];
  gitTokens: GitTokenSeeds;
  expiresAt: GitTokenExpiries;
  identity: { name: string; email: string } | null;
}> {
  const bindings: GitCredentialBindingSeed[] = [];
  let identity: { name: string; email: string } | null = null;
  for (const selection of selections) {
    let token: string | null = null;
    let tokenExpiresAt: string | undefined;
    if (
      selection.provider === "github" &&
      selection.installationId > 0 &&
      selection.repositoryIds.length > 0
    ) {
      // This callback belongs immediately next to the side effect. Turn startup
      // performs its own admission check, but lazy provisioning and proactive
      // renewal can happen much later in an intentionally unbounded run. Recheck
      // the current workspace binding before every host-brokered or built-in
      // GitHub installation-token mint.
      await options.authorizeGitHubTokenMint?.({
        installationId: selection.installationId,
        repositoryIds: selection.repositoryIds,
      });
    }
    if (options?.gitCredentials && options.scope) {
      const request = gitCredentialsRequestForSelection(
        options.scope,
        requireGitCredentialAuthority(options),
        selection,
        "token",
      );
      const minted: GitCredentials = await options.gitCredentials(request);
      // workspace-scope cross-check: assert the provider scoped the token to THIS run's workspace
      // before accepting the token for clone seeding.
      assertWorkspaceEcho("gitCredentials", options.scope, minted.workspaceId);
      assertGitCredentialBindingEcho(selection, request, minted);
      if (!minted.token) {
        throw new Error(
          "connection-credential provider (gitCredentials) did not return a token for a token request",
        );
      }
      token = minted.token;
      tokenExpiresAt = minted.expiresAt
        ? validatedGitCredentialExpiry(selection.provider, minted.expiresAt)
        : undefined;
      if (minted.identity) {
        identity = minted.identity;
      } else if (selection.provider === "github") {
        identity = githubAppBotIdentity(settings);
      }
    } else if (selection.provider === "github" && selection.installationId > 0) {
      const minted = await createGitHubAppInstallationTokenWithExpiry(settings, {
        installationId: selection.installationId,
        repositoryIds: selection.repositoryIds,
      });
      token = minted.token;
      tokenExpiresAt = minted.expiresAt
        ? validatedGitCredentialExpiry("github", minted.expiresAt)
        : undefined;
      identity = githubAppBotIdentity(settings);
    }
    if (token) {
      bindings.push({
        credentialBindingId: selection.credentialBindingId,
        provider: selection.provider,
        token,
        ...(tokenExpiresAt ? { expiresAt: tokenExpiresAt } : {}),
      });
    }
  }
  const gitTokens: GitTokenSeeds = {};
  const expiresAt: GitTokenExpiries = {};
  const counts = new Map<GitCredentialProvider, number>();
  for (const binding of bindings) {
    counts.set(binding.provider, (counts.get(binding.provider) ?? 0) + 1);
  }
  for (const binding of bindings) {
    binding.providerBindingCount = counts.get(binding.provider) ?? 1;
    if (counts.get(binding.provider) !== 1) continue;
    gitTokens[binding.provider] = binding.token;
    if (binding.expiresAt) expiresAt[binding.provider] = binding.expiresAt;
  }
  return { bindings, gitTokens, expiresAt, identity };
}

function validatedGitCredentialExpiry(provider: GitCredentialProvider, value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`connection-credential provider (${provider}) returned an invalid expiresAt`);
  }
  return new Date(timestamp).toISOString();
}

async function resolveRunGitIdentityWithSelections(
  settings: Settings,
  selections: GitCredentialSelection[],
  options: RunGitCredentialOptions,
): Promise<{ name: string; email: string } | null> {
  let identity: { name: string; email: string } | null = null;
  for (const selection of selections) {
    if (options.gitCredentials && options.scope) {
      const request = gitCredentialsRequestForSelection(
        options.scope,
        requireGitCredentialAuthority(options),
        selection,
        "identity",
      );
      const resolved: GitCredentials = await options.gitCredentials(request);
      assertWorkspaceEcho("gitCredentials", options.scope, resolved.workspaceId);
      assertGitCredentialBindingEcho(selection, request, resolved);
      if (resolved.identity) {
        identity = resolved.identity;
      } else if (selection.provider === "github") {
        identity = githubAppBotIdentity(settings);
      }
    } else if (selection.provider === "github" && selection.installationId > 0) {
      identity = githubAppBotIdentity(settings);
    }
  }
  return identity;
}

type GitCredentialSelection = {
  provider: GitCredentialProvider;
  credentialBindingId: string;
  explicitCredentialBinding: boolean;
  requireBindingEcho: boolean;
  providerHost?: string;
  installationId: number;
  repositoryIds: number[];
  repositoryRefs: GitCredentialRepositoryRef[];
};

function gitCredentialsRequestForSelection(
  scope: ConnectionScope,
  authority: GitCredentialAuthority,
  selection: GitCredentialSelection,
  purpose?: "token" | "identity",
): Parameters<NonNullable<ConnectionCredentialsPort["gitCredentials"]>>[0] {
  const legacy = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    ...authority,
    ...(purpose ? { purpose } : {}),
    installationId: selection.installationId,
    repositoryIds: selection.repositoryIds,
  };
  const bindingEcho = selection.requireBindingEcho
    ? {
        credentialBindingId: selection.credentialBindingId,
        provider: selection.provider,
        ...(selection.providerHost ? { providerHost: selection.providerHost } : {}),
      }
    : {};
  if (selection.provider === "github") {
    return {
      ...legacy,
      ...bindingEcho,
      repositoryRefs: selection.repositoryRefs,
    };
  }
  return {
    ...legacy,
    ...bindingEcho,
    provider: selection.provider,
    repositoryRefs: selection.repositoryRefs,
  };
}

function requireGitCredentialAuthority(options: RunGitCredentialOptions): GitCredentialAuthority {
  if (!options.authority) {
    throw new Error("host git credential resolution requires immutable session turn authority");
  }
  return options.authority;
}

function assertGitCredentialBindingEcho(
  selection: GitCredentialSelection,
  request: Parameters<NonNullable<ConnectionCredentialsPort["gitCredentials"]>>[0],
  minted: GitCredentials,
): void {
  if (!selection.requireBindingEcho) return;
  if (minted.credentialBindingId !== request.credentialBindingId) {
    throw new Error(
      `connection-credential provider (${selection.provider}) returned the wrong credential binding`,
    );
  }
  if (minted.provider !== selection.provider) {
    throw new Error(
      `connection-credential provider (${selection.provider}) returned the wrong provider echo`,
    );
  }
  if (request.providerHost && minted.providerHost !== request.providerHost) {
    throw new Error(
      `connection-credential provider (${selection.provider}) returned the wrong provider host echo`,
    );
  }
}

/**
 * The GitHub App installation + repository ids a run's git-credential mint
 * would use for these resources, or null when no GitHub token would be minted.
 * Derived from gitCredentialSelections so workspace-authorization rechecks
 * cover exactly the ids that reach createGitHubAppInstallationToken —
 * including legacy string-typed installationId/repositoryId refs, which the
 * mint path coerces via positiveInteger.
 */
export function gitHubTokenMintSelections(
  resources: ResourceRef[],
): Array<{ installationId: number; repositoryIds: number[] }> {
  return gitCredentialSelections(resources)
    .filter(
      (candidate) =>
        candidate.provider === "github" &&
        candidate.installationId > 0 &&
        candidate.repositoryIds.length > 0,
    )
    .map(({ installationId, repositoryIds }) => ({ installationId, repositoryIds }));
}

/** @deprecated Use gitHubTokenMintSelections for multi-installation sessions. */
export function gitHubTokenMintSelection(
  resources: ResourceRef[],
): { installationId: number; repositoryIds: number[] } | null {
  const selections = gitHubTokenMintSelections(resources);
  if (selections.length > 1) {
    throw new Error("GitHub resources span multiple credential bindings");
  }
  return selections[0] ?? null;
}

function gitCredentialSelections(resources: ResourceRef[]): GitCredentialSelection[] {
  const byBinding = new Map<string, GitCredentialSelection>();
  const remoteBindings = new Map<string, string>();
  const bindingProviders = new Map<string, GitCredentialProvider>();
  for (const resource of resources) {
    if (resource.kind !== "repository") {
      continue;
    }
    const provider = repositoryCredentialProvider(resource);
    if (!provider) {
      continue;
    }
    const installationId =
      provider === "github"
        ? (positiveInteger(resource.githubInstallationId ?? resource.installationId) ?? 0)
        : 0;
    const credentialBindingId = gitCredentialBindingIdForRepository(resource, provider)!;
    const bindingKey = `${provider}\u0000${credentialBindingId}`;
    const boundProvider = bindingProviders.get(credentialBindingId);
    if (boundProvider && boundProvider !== provider) {
      throw new Error(
        `credential binding ${credentialBindingId} is assigned to multiple Git providers`,
      );
    }
    bindingProviders.set(credentialBindingId, provider);
    const normalizedRemote = normalizedGitRemote(resource.uri);
    const claimedBinding = remoteBindings.get(normalizedRemote);
    if (claimedBinding && claimedBinding !== bindingKey) {
      throw new Error(
        `repository remote ${resource.uri} is claimed by multiple credential bindings`,
      );
    }
    remoteBindings.set(normalizedRemote, bindingKey);
    const entry = byBinding.get(bindingKey) ?? {
      provider,
      credentialBindingId,
      explicitCredentialBinding: Boolean(resource.credentialBindingId),
      requireBindingEcho: false,
      installationId: 0,
      repositoryIds: [],
      repositoryRefs: [],
    };
    entry.explicitCredentialBinding ||= Boolean(resource.credentialBindingId);
    const ref = gitCredentialRepositoryRef(resource, provider);
    entry.repositoryRefs.push(ref);
    if (provider === "github") {
      const repositoryId = positiveInteger(resource.githubRepositoryId ?? resource.repositoryId);
      if (installationId && repositoryId) {
        if (entry.installationId > 0 && entry.installationId !== installationId) {
          throw new Error(
            `GitHub credential binding ${credentialBindingId} spans multiple installations`,
          );
        }
        entry.installationId = installationId;
        entry.repositoryIds.push(repositoryId);
      }
    }
    byBinding.set(bindingKey, entry);
  }
  const selections = [...byBinding.values()];
  const providerCounts = new Map<GitCredentialProvider, number>();
  for (const selection of selections) {
    providerCounts.set(selection.provider, (providerCounts.get(selection.provider) ?? 0) + 1);
    const hosts = new Set(
      selection.repositoryRefs.map((ref) => normalizedGitHost(ref.uri)).filter(Boolean),
    );
    const [providerHost] = hosts;
    if (hosts.size === 1 && providerHost) selection.providerHost = providerHost;
  }
  for (const selection of selections) {
    selection.requireBindingEcho =
      selection.explicitCredentialBinding || (providerCounts.get(selection.provider) ?? 0) > 1;
  }
  return selections;
}

function normalizedGitHost(uri: string): string {
  try {
    return new URL(uri).host.toLowerCase();
  } catch {
    return "";
  }
}

function normalizedGitRemote(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
  } catch {
    return uri
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  }
}

function repositoryCredentialProvider(
  resource: Extract<ResourceRef, { kind: "repository" }>,
): GitCredentialProvider | null {
  return gitCredentialProviderForRepository(resource);
}

function gitCredentialRepositoryRef(
  resource: Extract<ResourceRef, { kind: "repository" }>,
  provider: GitCredentialProvider,
): GitCredentialRepositoryRef {
  return {
    provider,
    ...(resource.credentialBindingId ? { credentialBindingId: resource.credentialBindingId } : {}),
    ...(resource.access ? { access: resource.access } : {}),
    uri: resource.uri,
    ref: resource.ref,
    ...(resource.repositoryId !== undefined
      ? { repositoryId: resource.repositoryId }
      : resource.githubRepositoryId !== undefined
        ? { repositoryId: resource.githubRepositoryId }
        : {}),
    ...(resource.installationId !== undefined
      ? { installationId: resource.installationId }
      : resource.githubInstallationId !== undefined
        ? { installationId: resource.githubInstallationId }
        : {}),
    ...(resource.projectId !== undefined ? { projectId: resource.projectId } : {}),
    ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
  };
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}
