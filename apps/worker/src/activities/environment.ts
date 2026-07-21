import {
  applyGitAuthPointerEnvironment,
  firstPartyMcpWorkspaceUrl,
  stableSandboxEnvironmentForRun,
  type Settings,
} from "@opengeni/config";
import {
  signDelegatedAccessToken,
  type ConnectionCredentialsPort,
  type GitCredentialProvider,
  type GitCredentialRepositoryRef,
  type GitCredentials,
  type ResourceRef,
  type SandboxSecrets,
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
export type MintedRunGitCredentials = {
  gitTokens: GitTokenSeeds;
  expiresAt: GitTokenExpiries;
};

export type GitHubTokenMintAuthorization = (selection: {
  installationId: number;
  repositoryIds: number[];
}) => Promise<void>;

type RunGitCredentialOptions = {
  scope?: ConnectionScope;
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
  toolspaceToken?: string;
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
  let toolspaceToken: string | undefined;
  if (
    settings.toolspaceEnabled &&
    settings.delegationSecret &&
    options.scope &&
    options.sessionId &&
    options.runId
  ) {
    toolspaceToken = await signDelegatedAccessToken(settings.delegationSecret, {
      accountId: options.scope.accountId,
      workspaceId: options.scope.workspaceId,
      subjectId: `sandbox:${options.runId}`,
      subjectLabel: "sandbox toolspace",
      permissions: ["toolspace:call"],
      sessionId: options.sessionId,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    });
    environment.OPENGENI_TOOLSPACE_URL ??= firstPartyMcpWorkspaceUrl(
      settings,
      options.scope.workspaceId,
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
    return { environment, ...(toolspaceToken ? { toolspaceToken } : {}) };
  }
  if (options.deferGitHubToken) {
    applyGitAuthPointerEnvironment(
      environment,
      await resolveRunGitIdentityWithSelections(settings, selections, options),
    );
    return { environment, ...(toolspaceToken ? { toolspaceToken } : {}) };
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
    ...(toolspaceToken ? { toolspaceToken } : {}),
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
  return Object.keys(minted.gitTokens).length > 0
    ? { gitTokens: minted.gitTokens, expiresAt: minted.expiresAt }
    : undefined;
}

export async function mintRunGitTokens(
  settings: Settings,
  resources: ResourceRef[],
  options: RunGitCredentialOptions = {},
): Promise<GitTokenSeeds | undefined> {
  return (await mintRunGitCredentials(settings, resources, options))?.gitTokens;
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
  options: {
    scope?: ConnectionScope;
    gitCredentials?: ConnectionCredentialsPort["gitCredentials"];
  } = {},
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
  gitTokens: GitTokenSeeds;
  expiresAt: GitTokenExpiries;
  identity: { name: string; email: string } | null;
}> {
  const gitTokens: GitTokenSeeds = {};
  const expiresAt: GitTokenExpiries = {};
  let identity: { name: string; email: string } | null = null;
  for (const selection of selections) {
    let token: string | null = null;
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
      const request = gitCredentialsRequestForSelection(options.scope, selection, "token");
      const minted: GitCredentials = await options.gitCredentials(request);
      // workspace-scope cross-check: assert the provider scoped the token to THIS run's workspace
      // before accepting the token for clone seeding.
      assertWorkspaceEcho("gitCredentials", options.scope, minted.workspaceId);
      if (!minted.token) {
        throw new Error(
          "connection-credential provider (gitCredentials) did not return a token for a token request",
        );
      }
      token = minted.token;
      if (minted.expiresAt) {
        expiresAt[selection.provider] = validatedGitCredentialExpiry(
          selection.provider,
          minted.expiresAt,
        );
      }
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
      if (minted.expiresAt) {
        expiresAt.github = validatedGitCredentialExpiry("github", minted.expiresAt);
      }
      identity = githubAppBotIdentity(settings);
    }
    if (token) {
      gitTokens[selection.provider] = token;
    }
  }
  return { gitTokens, expiresAt, identity };
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
  options: {
    scope?: ConnectionScope;
    gitCredentials?: ConnectionCredentialsPort["gitCredentials"];
  },
): Promise<{ name: string; email: string } | null> {
  let identity: { name: string; email: string } | null = null;
  for (const selection of selections) {
    if (options.gitCredentials && options.scope) {
      const resolved: GitCredentials = await options.gitCredentials(
        gitCredentialsRequestForSelection(options.scope, selection, "identity"),
      );
      assertWorkspaceEcho("gitCredentials", options.scope, resolved.workspaceId);
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
  installationId: number;
  repositoryIds: number[];
  repositoryRefs: GitCredentialRepositoryRef[];
};

function gitCredentialsRequestForSelection(
  scope: ConnectionScope,
  selection: GitCredentialSelection,
  purpose?: "token" | "identity",
): Parameters<NonNullable<ConnectionCredentialsPort["gitCredentials"]>>[0] {
  const legacy = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    ...(purpose ? { purpose } : {}),
    installationId: selection.installationId,
    repositoryIds: selection.repositoryIds,
  };
  if (selection.provider === "github") {
    return {
      ...legacy,
      repositoryRefs: selection.repositoryRefs,
    };
  }
  return {
    ...legacy,
    provider: selection.provider,
    repositoryRefs: selection.repositoryRefs,
  };
}

/**
 * The GitHub App installation + repository ids a run's git-credential mint
 * would use for these resources, or null when no GitHub token would be minted.
 * Derived from gitCredentialSelections so workspace-authorization rechecks
 * cover exactly the ids that reach createGitHubAppInstallationToken —
 * including legacy string-typed installationId/repositoryId refs, which the
 * mint path coerces via positiveInteger.
 */
export function gitHubTokenMintSelection(
  resources: ResourceRef[],
): { installationId: number; repositoryIds: number[] } | null {
  const selection = gitCredentialSelections(resources).find(
    (candidate) => candidate.provider === "github",
  );
  if (!selection || selection.installationId <= 0 || selection.repositoryIds.length === 0) {
    return null;
  }
  return { installationId: selection.installationId, repositoryIds: selection.repositoryIds };
}

function gitCredentialSelections(resources: ResourceRef[]): GitCredentialSelection[] {
  const byProvider = new Map<GitCredentialProvider, GitCredentialSelection>();
  for (const resource of resources) {
    if (resource.kind !== "repository") {
      continue;
    }
    const provider = repositoryCredentialProvider(resource);
    if (!provider) {
      continue;
    }
    const entry = byProvider.get(provider) ?? {
      provider,
      installationId: 0,
      repositoryIds: [],
      repositoryRefs: [],
    };
    const ref = gitCredentialRepositoryRef(resource, provider);
    entry.repositoryRefs.push(ref);
    if (provider === "github") {
      const installationId = positiveInteger(
        resource.githubInstallationId ?? resource.installationId,
      );
      const repositoryId = positiveInteger(resource.githubRepositoryId ?? resource.repositoryId);
      if (installationId && repositoryId) {
        if (entry.installationId > 0 && entry.installationId !== installationId) {
          throw new Error("GitHub App repository resources must belong to one installation");
        }
        entry.installationId = installationId;
        entry.repositoryIds.push(repositoryId);
      }
    }
    byProvider.set(provider, entry);
  }
  return [...byProvider.values()];
}

function repositoryCredentialProvider(
  resource: Extract<ResourceRef, { kind: "repository" }>,
): GitCredentialProvider | null {
  if (resource.provider) {
    return resource.provider;
  }
  if (
    positiveInteger(resource.githubInstallationId) &&
    positiveInteger(resource.githubRepositoryId)
  ) {
    return "github";
  }
  return null;
}

function gitCredentialRepositoryRef(
  resource: Extract<ResourceRef, { kind: "repository" }>,
  provider: GitCredentialProvider,
): GitCredentialRepositoryRef {
  return {
    provider,
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
