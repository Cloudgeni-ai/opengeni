import {
  gitCredentialBindingIdForRepository,
  gitCredentialProviderForRepository,
  normalizeRepositoryTransportUri,
  resourceMountPath,
  resourcesIncludeRepository,
  type GitCredentialProvider,
  type ResourceRef,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

const SANDBOX_WORKSPACE_ROOT = "/workspace";

/** A removal that leaves nothing to do in the sandbox. */
export type RepositoryRemovalPlan = {
  /** Absolute sandbox folders to delete. */
  folders: string[];
  /** Credential binding token files (by hash) no attached repository uses. */
  bindingHashes: string[];
  /** Bindings among `bindingHashes` holding a dedicated GitHub App token. */
  revocableBindingHashes: string[];
  /** Providers no attached repository uses any more. */
  providers: GitCredentialProvider[];
};

function bindingHash(credentialBindingId: string): string {
  // Same derivation as the runtime credential helper's token file names.
  return createHash("sha256").update(credentialBindingId, "utf8").digest("hex").slice(0, 32);
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isGitHubDotCom(uri: string): boolean {
  try {
    return new URL(normalizeRepositoryTransportUri(uri)).host === "github.com";
  } catch {
    return false;
  }
}

/**
 * What removing `removed` repositories means for a managed sandbox whose
 * session still attaches `current` resources. A folder is kept when an
 * attached resource uses the same path (for example the repository was
 * attached again); a credential binding or provider token is kept while an
 * attached repository still uses it, because this turn's clone setup
 * rewrites it with a token narrowed to the remaining repositories.
 */
export function repositoryRemovalPlan(
  removed: readonly RepositoryResource[],
  current: readonly ResourceRef[],
  options: {
    /**
     * Whether Opengeni's own GitHub App minted the box's GitHub tokens, so a
     * dedicated token may be revoked. A host-supplied token is never revoked.
     */
    revokeDedicatedGitHubAppTokens?: boolean;
  } = {},
): RepositoryRemovalPlan {
  const currentPaths = current.flatMap((resource) => {
    try {
      return [resourceMountPath(resource)];
    } catch {
      return [];
    }
  });
  const currentRepositories = current.filter(
    (resource): resource is RepositoryResource => resource.kind === "repository",
  );
  const currentBindingIds = new Set<string>();
  const currentProviders = new Set<GitCredentialProvider>();
  for (const resource of currentRepositories) {
    const provider = gitCredentialProviderForRepository(resource);
    if (!provider) continue;
    currentProviders.add(provider);
    const bindingId = gitCredentialBindingIdForRepository(resource, provider);
    if (bindingId) currentBindingIds.add(bindingId);
  }

  const folders = new Set<string>();
  const bindingHashes = new Set<string>();
  const revocable = new Set<string>();
  const providers = new Set<GitCredentialProvider>();
  for (const resource of removed) {
    if (resourcesIncludeRepository(current, resource.uri)) continue;
    let mountPath: string;
    try {
      mountPath = resourceMountPath(resource);
    } catch {
      continue;
    }
    const folder = posixPath.join(SANDBOX_WORKSPACE_ROOT, mountPath);
    if (
      folder.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`) &&
      !mountPath.split("/").includes("..") &&
      mountPath.split("/")[0] !== ".opengeni" &&
      !currentPaths.some((path) => pathsOverlap(path, mountPath))
    ) {
      folders.add(folder);
    }
    const provider = gitCredentialProviderForRepository(resource);
    if (!provider) continue;
    if (!currentProviders.has(provider)) providers.add(provider);
    const bindingId = gitCredentialBindingIdForRepository(resource, provider);
    if (!bindingId || currentBindingIds.has(bindingId)) continue;
    const hash = bindingHash(bindingId);
    bindingHashes.add(hash);
    if (
      options.revokeDedicatedGitHubAppTokens === true &&
      provider === "github" &&
      resource.connectionType !== "github_personal" &&
      isGitHubDotCom(resource.uri)
    ) {
      revocable.add(hash);
    }
  }
  return {
    folders: [...folders].sort(),
    bindingHashes: [...bindingHashes].sort(),
    revocableBindingHashes: [...revocable].sort(),
    providers: [...providers].sort(),
  };
}

export function repositoryRemovalPlanIsEmpty(plan: RepositoryRemovalPlan): boolean {
  return (
    plan.folders.length === 0 && plan.bindingHashes.length === 0 && plan.providers.length === 0
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sandbox command for a removal plan. It deletes the folders, best-effort
 * revokes a dedicated GitHub App installation token before deleting its file
 * (the token never enters argv: curl reads the header from a private file),
 * and deletes provider token files no attached repository uses. Every step is
 * idempotent, so the command is safe to run on every turn.
 */
export function repositoryRemovalCommand(plan: RepositoryRemovalPlan): string {
  const lines = [
    "set +x",
    "set -eu",
    'export HOME="${HOME:-/workspace}"',
    'credential_dir="${OPENGENI_GIT_CREDENTIALS_DIR:-$HOME/.opengeni/git-credentials}"',
    "revoke_github_app_token() {",
    '  token_file="$1"',
    '  [ -f "$token_file" ] && [ ! -L "$token_file" ] || return 0',
    "  command -v curl >/dev/null 2>&1 || return 0",
    '  token="$(cat "$token_file" 2>/dev/null || true)"',
    '  [ -n "$token" ] || return 0',
    '  header_file="$(mktemp)" || return 0',
    '  chmod 600 "$header_file"',
    '  printf \'Authorization: Bearer %s\\n\' "$token" > "$header_file"',
    "  unset token",
    '  curl -fsS --max-time 10 -o /dev/null -X DELETE -H "@$header_file" -H "Accept: application/vnd.github+json" https://api.github.com/installation/token >/dev/null 2>&1 || true',
    '  rm -f -- "$header_file"',
    "}",
  ];
  for (const folder of plan.folders) {
    lines.push(`rm -rf -- ${shellQuote(folder)}`);
  }
  for (const hash of plan.bindingHashes) {
    const file = `"$credential_dir"/${shellQuote(`${hash}-token`)}`;
    if (plan.revocableBindingHashes.includes(hash)) {
      lines.push(`revoke_github_app_token ${file}`);
    }
    lines.push(`rm -f -- ${file}`);
  }
  for (const provider of plan.providers) {
    if (provider === "github") {
      lines.push('rm -f -- "${OPENGENI_GIT_TOKEN_FILE:-$HOME/.opengeni/git-token}"');
    }
    lines.push(`rm -f -- "$credential_dir"/${shellQuote(`${provider}-token`)}`);
  }
  return lines.join("\n");
}
