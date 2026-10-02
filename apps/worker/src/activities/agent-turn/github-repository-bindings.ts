import type { Settings } from "@opengeni/config";
import type { CredentialAuthNeededPayload, ResourceRef } from "@opengeni/contracts";
import {
  applyGitHubRepositoryBindings,
  listGitHubRepositoryBindingCandidates,
  resolveGitHubRepositoryBindings,
  unboundGitHubRepositoryResources,
  type GitHubRepositoryBinding,
  type GitHubRepositoryBindingCandidate,
  type GitHubRepositoryBindingLookup,
  type GitHubRepositoryBindingResolution,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import {
  createGitHubAppInstallationRepositoryLookup,
  githubAppMissingSettings,
} from "@opengeni/github";

/**
 * Turn-time GitHub App binding resolution for bare repository URIs.
 *
 * The web composer and the MCP repository catalog stamp
 * `githubInstallationId`/`githubRepositoryId` on every bound repository, but an
 * API caller, an older session, or an agent-spawned child may still carry a
 * bare `https://github.com/<owner>/<repo>` resource. The workspace allowlist
 * stores repository ids only, so the worker (which already talks to GitHub to
 * mint the sandbox token) resolves the URI here: the owner selects the
 * workspace's auditable installation(s) from Postgres, one server-side
 * metadata-read supplies GitHub's repository id, and the allowlist decides.
 * Exactly one allowlisted match stamps the ids for this turn's in-memory
 * resources; every other case keeps the resource bare (anonymous clone, as
 * before) and reports a visible warning. Nothing here is durable and nothing
 * can fail the turn.
 */

/** Process-local lookup memo: recovered turns and sibling children reuse it. */
export const GITHUB_REPOSITORY_LOOKUP_CACHE_TTL_MS = 10 * 60_000;
const GITHUB_REPOSITORY_LOOKUP_CACHE_MAX_ENTRIES = 4_096;

type LookupCacheEntry = { value: { id: number } | null; expiresAt: number };

export type GitHubRepositoryLookupCache = {
  get: (key: string, now: number) => LookupCacheEntry | undefined;
  set: (key: string, entry: LookupCacheEntry) => void;
  clear: () => void;
};

export function createGitHubRepositoryLookupCache(
  maxEntries = GITHUB_REPOSITORY_LOOKUP_CACHE_MAX_ENTRIES,
): GitHubRepositoryLookupCache {
  const entries = new Map<string, LookupCacheEntry>();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

const defaultLookupCache = createGitHubRepositoryLookupCache();
const defaultWarningCache = createGitHubRepositoryLookupCache();

function lookupCacheKey(
  workspaceId: string,
  input: { installationId: number; owner: string; name: string },
): string {
  return `${workspaceId}\u0000${input.installationId}\u0000${input.owner.toLowerCase()}/${input.name.toLowerCase()}`;
}

/**
 * Wrap a live lookup with the process-local TTL memo. Successful ids and
 * negative (not visible through this installation) answers are both cached;
 * failures are not, so a GitHub blip is retried on the next turn.
 */
export function cachedGitHubRepositoryBindingLookup(input: {
  workspaceId: string;
  lookup: GitHubRepositoryBindingLookup;
  cache?: GitHubRepositoryLookupCache;
  now?: () => number;
  ttlMs?: number;
}): GitHubRepositoryBindingLookup {
  const cache = input.cache ?? defaultLookupCache;
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? GITHUB_REPOSITORY_LOOKUP_CACHE_TTL_MS;
  return async (request) => {
    const key = lookupCacheKey(input.workspaceId, request);
    const cached = cache.get(key, now());
    if (cached) return cached.value;
    const value = await input.lookup(request);
    cache.set(key, { value: value ? { id: value.id } : null, expiresAt: now() + ttlMs });
    return value;
  };
}

export type TurnGitHubRepositoryBindings = {
  resources: ResourceRef[];
  bindings: Map<string, GitHubRepositoryBinding>;
  resolutions: GitHubRepositoryBindingResolution[];
  warnings: CredentialAuthNeededPayload[];
  /** Apply the same bindings to a sibling resource list (runtime resources). */
  apply: (resources: readonly ResourceRef[]) => ResourceRef[];
};

export async function resolveTurnGitHubRepositoryBindings(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  resources: readonly ResourceRef[];
  /** Test seam; defaults to the workspace's auditable bindings under RLS. */
  listCandidates?: (
    db: Database,
    workspaceId: string,
  ) => Promise<GitHubRepositoryBindingCandidate[]>;
  /** Test seam; defaults to one live GitHub App lookup client per call. */
  lookup?: GitHubRepositoryBindingLookup;
  /** Test seam; defaults to the process-local TTL memo. */
  lookupCache?: GitHubRepositoryLookupCache;
}): Promise<TurnGitHubRepositoryBindings> {
  const passthrough = (): TurnGitHubRepositoryBindings => ({
    resources: [...input.resources],
    bindings: new Map(),
    resolutions: [],
    warnings: [],
    apply: (resources) => [...resources],
  });
  if (unboundGitHubRepositoryResources(input.resources).length === 0) {
    return passthrough();
  }
  let lookup = input.lookup;
  if (!lookup) {
    // Without App signing credentials no installation token could be minted
    // for a resolved id anyway, so a bare repository stays anonymous.
    if (githubAppMissingSettings(input.settings).length > 0) {
      return passthrough();
    }
    const live = createGitHubAppInstallationRepositoryLookup(input.settings);
    lookup = async (request) => {
      const repository = await live(request);
      return repository ? { id: repository.id } : null;
    };
  }
  const candidates = await (input.listCandidates ?? listGitHubRepositoryBindingCandidates)(
    input.db,
    input.workspaceId,
  );
  if (candidates.length === 0) {
    return passthrough();
  }
  const resolved = await resolveGitHubRepositoryBindings({
    resources: input.resources,
    candidates,
    lookup: cachedGitHubRepositoryBindingLookup({
      workspaceId: input.workspaceId,
      lookup,
      ...(input.lookupCache ? { cache: input.lookupCache } : {}),
    }),
  });
  return {
    resources: resolved.resources,
    bindings: resolved.bindings,
    resolutions: resolved.resolutions,
    warnings: resolved.resolutions.flatMap(
      (resolution) => gitHubRepositoryBindingWarning(resolution) ?? [],
    ),
    apply: (resources) => applyGitHubRepositoryBindings(resources, resolved.bindings),
  };
}

/**
 * The visible warning for a bound-but-unusable repository. An unbound owner
 * is the ordinary anonymous public clone and produces no warning; a resolved
 * repository needs none.
 */
export function gitHubRepositoryBindingWarning(
  resolution: GitHubRepositoryBindingResolution,
): CredentialAuthNeededPayload | null {
  const repository = `${resolution.owner}/${resolution.name}`;
  switch (resolution.outcome.status) {
    case "resolved":
    case "unbound":
      return null;
    case "not_allowlisted":
      return {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "insufficient_scope",
        resource: resolution.uri,
        message: `GitHub repository ${repository} is not in the repository allowlist of the workspace's GitHub App installation for ${resolution.owner}. The sandbox clones it anonymously and cannot push or use gh until the repository is added to that installation.`,
      };
    case "ambiguous":
      return {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "insufficient_scope",
        resource: resolution.uri,
        message: `GitHub repository ${repository} is allowlisted by more than one GitHub App installation in this workspace (${resolution.outcome.installationIds.join(", ")}). Select it with an explicit installation, or unlink the duplicate binding, to receive a scoped token.`,
      };
    case "unavailable":
      return {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "refresh_failed",
        resource: resolution.uri,
        message: `GitHub repository ${repository} could not be resolved against the workspace's GitHub App installation (${resolution.outcome.message}). The sandbox clones it anonymously for this turn.`,
      };
  }
}

export type ApplyTurnGitHubRepositoryBindingsInput = {
  db: Database;
  settings: Settings;
  workspaceId: string;
  sessionId: string;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  /** Product-owned credentials take precedence over inferred platform bindings. */
  hasCredentialProvider?: boolean;
  claimedTurnResources: readonly ResourceRef[];
  claimedRuntimeResources: readonly ResourceRef[];
  /** Publishes one attempt-fenced session event batch. */
  publish: (
    events: Array<{ type: "credential.auth_needed"; payload: CredentialAuthNeededPayload }>,
  ) => Promise<void>;
  /** Operational log for a resolution that threw; the turn proceeds bare. */
  warn: (message: string, fields: Record<string, string>) => void;
  /** Test seam for the resolver itself. */
  resolve?: typeof resolveTurnGitHubRepositoryBindings;
  /** Test seam for the per-session warning dedupe memo. */
  warningCache?: GitHubRepositoryLookupCache;
  now?: () => number;
};

/**
 * The run.ts wiring in one testable seam: skip for a Connected Machine,
 * proceed bare when resolution throws, stamp both the turn and runtime
 * resource lists from one resolution, and publish a bound-but-unusable
 * warning once per session and URI within the memo window (the resolution
 * itself already runs once per attempt).
 */
export async function applyTurnGitHubRepositoryBindings(
  input: ApplyTurnGitHubRepositoryBindingsInput,
): Promise<{ turnResources: ResourceRef[]; runtimeResources: ResourceRef[] }> {
  const passthrough = {
    turnResources: [...input.claimedTurnResources],
    runtimeResources: [...input.claimedRuntimeResources],
  };
  if (input.activeSandboxBackend === "selfhosted" || input.hasCredentialProvider) {
    return passthrough;
  }
  let resolved: TurnGitHubRepositoryBindings;
  try {
    resolved = await (input.resolve ?? resolveTurnGitHubRepositoryBindings)({
      db: input.db,
      settings: input.settings,
      workspaceId: input.workspaceId,
      resources: input.claimedTurnResources,
    });
  } catch (error) {
    input.warn("GitHub repository binding resolution skipped", {
      errorClass: error instanceof Error ? error.name : "Error",
      errorCode: "github_repository_binding_resolution_failed",
      origin: "worker",
    });
    return passthrough;
  }
  const now = input.now ?? Date.now;
  const warningCache = input.warningCache ?? defaultWarningCache;
  const warnings = resolved.warnings.filter((payload) => {
    const key = `${input.sessionId}\u0000${payload.resource ?? ""}\u0000${payload.reason}`;
    if (warningCache.get(key, now())) return false;
    warningCache.set(key, {
      value: null,
      expiresAt: now() + GITHUB_REPOSITORY_LOOKUP_CACHE_TTL_MS,
    });
    return true;
  });
  if (warnings.length > 0) {
    await input.publish(
      warnings.map((payload) => ({ type: "credential.auth_needed" as const, payload })),
    );
  }
  return {
    turnResources: resolved.resources,
    runtimeResources: resolved.apply(input.claimedRuntimeResources),
  };
}
