import {
  applyGitAuthPointerEnvironment,
  stableSandboxEnvironmentForRun,
  type Settings,
} from "@opengeni/config";
import {
  type ConnectionCredentialsPort,
  type GitCredentials,
  type ResourceRef,
  type SandboxSecrets,
} from "@opengeni/contracts";
import {
  loadWorkspaceEnvironmentForRun as loadWorkspaceEnvironmentForRunFromDb,
  type Database,
  type WorkspaceEnvironmentForRun,
} from "@opengeni/db";
import {
  createGitHubAppInstallationToken,
  githubAppBotIdentity,
} from "@opengeni/github";

// Re-exported from the shared @opengeni/db leaf (moved there so the API-direct
// attach paths can load the SAME decrypted workspace environment the turn
// declares — keeping the box-manifest env and agent-manifest env identical).
// Existing worker import sites (agent-turn) continue importing from here.
export {
  loadWorkspaceEnvironmentForRunFromDb as loadWorkspaceEnvironmentForRun,
  type WorkspaceEnvironmentForRun,
};

// §7.6 P4a — the run's workspace identity, threaded so the connection-credential
// provider can be called with the run's tenant context AND so the FORK-7
// cross-check has the run's workspace to assert the provider's echo against.
export type ConnectionScope = {
  accountId: string;
  workspaceId: string;
};

// §7.6 P4a — load the run's workspace environment, delegating the DECRYPT to a
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
    environmentId,
  });
  // FORK-7: the provider must echo THIS run's workspace before we apply its
  // decrypted values into the sandbox.
  assertWorkspaceEcho("sandboxSecrets", scope, secrets.workspaceId);
  return {
    id: secrets.id ?? environmentId,
    name: secrets.name ?? environmentId,
    description: secrets.description ?? null,
    values: secrets.values,
  };
}

// §7.6 FORK-7 cross-check. A credential provider echoes the workspace it scoped
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
  // §7.6 P4a — optional host git-credential provider + the run scope it needs
  // (unset, the standalone default → self-mint from `settings` byte-for-byte).
  // `skipGitHubToken` (Stage D): a connected-machine turn skips the inert platform
  // token mint entirely. `= {}` default so the non-optional reads below are safe.
  options: {
    skipGitHubToken?: boolean;
    scope?: ConnectionScope;
    gitCredentials?: ConnectionCredentialsPort["gitCredentials"];
  } = {},
): Promise<{ environment: Record<string, string>; gitToken?: string }> {
  // Precedence: deployment allowlist < git identity < workspace environment
  // < backend-aware HOME (the STABLE base, shared with the API-direct attach
  // paths via stableSandboxEnvironmentForRun) < platform run-scoped GitHub auth
  // (applied below, always last). Reserved name validation at write time prevents
  // workspace values from colliding with the platform-managed entries.
  //
  // TOKEN-BROKER (B1): the run-scoped GitHub App installation token is NO LONGER
  // layered into the box/agent MANIFEST env (no GH_TOKEN/GITHUB_TOKEN/GIT_CONFIG_*
  // extraheader). It is minted ONCE per turn and returned as `gitToken`; the caller
  // threads it OFF-MANIFEST as a clone-seed exec env (OPENGENI_GIT_TOKEN_SEED) so the
  // clone hook writes it to a stable FILE ($OPENGENI_GIT_TOKEN_FILE), and git auth
  // flows through GIT_ASKPASS -> that file. The manifest carries only the stable
  // pointers (GIT_ASKPASS, GIT_TERMINAL_PROMPT, identity, and — via the shared base —
  // OPENGENI_GIT_TOKEN_FILE), so the token VALUE never rides the manifest and the
  // SDK's per-turn provided-session env delta stays empty even though the token
  // rotates. The agent can refresh the token mid-turn via the `github_token` MCP tool.
  const environment = stableSandboxEnvironmentForRun(settings, workspaceEnvironment);
  const selection = githubRepositorySelection(resources);
  // NO-TOKEN SKIP (Stage D, change B): when the turn's EFFECTIVE compute backend is
  // a connected machine (selfhosted), the platform GitHub App installation token is
  // INERT — exec routes over NATS to the user's machine, which uses ITS OWN git
  // credentials, and the box that the token would auth is never created. So skip the
  // (network) token mint entirely and return the STABLE base env (no gitToken). Env-
  // parity holds: the SAME base object still feeds buildManifest + the SelfhostedSession
  // manifest, so the SDK's per-turn provided-session env delta stays empty
  // (validateNoEnvironmentDelta). The API-direct viewer attach path already drops the
  // token under this exact contract — proof a box runs fine without it.
  if (!selection || options.skipGitHubToken) {
    return { environment };
  }
  // Run-scoped sandbox preparation for GitHub App repository resources. When a
  // host binds `gitCredentials`, the HOST mints the installation token (BYO
  // GitHub App); otherwise OpenGeni self-mints from `settings` (today's path). A
  // SINGLE token is minted per turn and returned as `gitToken` (seeded to the box's
  // token file by the caller's clone hook) — NOT layered into the manifest env.
  let token: string;
  let identity: { name: string; email: string } | null;
  if (options?.gitCredentials && options.scope) {
    const minted: GitCredentials = await options.gitCredentials({
      accountId: options.scope.accountId,
      workspaceId: options.scope.workspaceId,
      installationId: selection.installationId,
      repositoryIds: selection.repositoryIds,
    });
    // FORK-7: assert the provider scoped the token to THIS run's workspace
    // before accepting the token for clone seeding.
    assertWorkspaceEcho("gitCredentials", options.scope, minted.workspaceId);
    token = minted.token;
    identity = minted.identity ?? githubAppBotIdentity(settings);
  } else {
    token = await createGitHubAppInstallationToken(settings, {
      installationId: selection.installationId,
      repositoryIds: selection.repositoryIds,
    });
    identity = githubAppBotIdentity(settings);
  }
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
  applyGitAuthPointerEnvironment(environment, identity);
  return { environment, gitToken: token };
}

function githubRepositorySelection(resources: ResourceRef[]): { installationId: number; repositoryIds: number[] } | null {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationId = positiveInteger(resource.githubInstallationId);
    const repositoryId = positiveInteger(resource.githubRepositoryId);
    return installationId && repositoryId ? [{ installationId, repositoryId }] : [];
  });
  if (selected.length === 0) {
    return null;
  }
  const installationId = selected[0]!.installationId;
  if (selected.some((item) => item.installationId !== installationId)) {
    throw new Error("GitHub App repository resources must belong to one installation");
  }
  return {
    installationId,
    repositoryIds: selected.map((item) => item.repositoryId),
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
