import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  PERSONAL_GITHUB_API_ORIGIN,
  PersonalGitHubConnectionMetadata,
  PersonalGitHubRepository,
  canonicalPersonalGitHubRepositoryUrl,
  isPersonalGitHubConnection,
  personalGitHubAccessCovers,
  personalGitHubAllRepositoriesEffectiveAccess,
  personalGitHubConnectionNeedsReconnect,
  type PersonalGitHubRepository as PersonalGitHubRepositoryContract,
  type PersonalGitHubRepositoryAccess,
} from "@opengeni/contracts/personal-github";
import {
  getConnectionMetadata,
  getPersonalGitHubRepositorySelectionState,
  type Database,
  type PersonalGitHubRepositorySelectionState,
  type PersonalGitHubSelectedRepositoryRecord,
} from "@opengeni/db";

/**
 * The one Your GitHub repository allowlist check. Every place that lets work
 * act on a repository as the person (session admission, the repository
 * picker, the Git broker, Git credentials, the github_personal tools and the
 * gh gateway) asks it, so "only these repositories" and "All my
 * repositories" mean the same thing everywhere.
 *
 * - Only these repositories: the repository must be in the saved list with
 *   enough access, and accepted work must still see the same list.
 * - All my repositories: any repository GitHub lets the person use, up to the
 *   chosen access. Accepted work keeps working while the mode stays as it
 *   was; it stops for good when the mode is turned off or its access changes,
 *   even if it is turned back on later.
 *
 * `personalGitHubRepositoryAuthority` is the pure decision over state the
 * caller already read. `checkPersonalGitHubRepositoryAccess` reads that state
 * itself and, in All my repositories, also asks GitHub (briefly cached).
 */

export type PersonalGitHubAcceptedRepositorySelection = NonNullable<
  McpPersonalConnectionDelegation["personalGitHubRepositorySelection"]
>;

export type PersonalGitHubRepositoryDenial =
  | "connection_unavailable"
  | "reconnect_required"
  | "connection_changed"
  | "outside_accepted_work"
  | "selection_changed"
  | "not_selected"
  | "not_found"
  | "read_denied"
  | "write_denied"
  | "provider_unavailable";

export type PersonalGitHubRepositoryAuthorityDecision =
  | { allowed: true; mode: "all"; allRepositoriesAccess: PersonalGitHubRepositoryAccess }
  | { allowed: true; mode: "selected"; selected: PersonalGitHubSelectedRepositoryRecord }
  | { allowed: false; reason: PersonalGitHubRepositoryDenial };

export type PersonalGitHubRepositoryLookup = {
  /** GitHub's numeric repository id, as a decimal string. */
  repositoryId?: string | undefined;
  /** `owner/name`, compared case-insensitively. */
  fullName?: string | undefined;
};

function sameRepository(
  candidate: { repositoryId: string; fullName: string },
  lookup: PersonalGitHubRepositoryLookup,
): boolean {
  if (lookup.repositoryId !== undefined) return candidate.repositoryId === lookup.repositoryId;
  return (
    lookup.fullName !== undefined &&
    candidate.fullName.toLowerCase() === lookup.fullName.toLowerCase()
  );
}

function canRead(permissions: PersonalGitHubSelectedRepositoryRecord["permissions"]): boolean {
  return (
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin
  );
}

function canWrite(permissions: PersonalGitHubSelectedRepositoryRecord["permissions"]): boolean {
  return permissions.push || permissions.maintain || permissions.admin;
}

/**
 * Does the work's accepted snapshot include this repository at `access`?
 * All my repositories includes every repository up to its access; otherwise
 * only the listed repositories with their own access.
 */
export function personalGitHubAcceptedSelectionCovers(
  accepted: PersonalGitHubAcceptedRepositorySelection,
  repository: PersonalGitHubRepositoryLookup,
  access: PersonalGitHubRepositoryAccess,
): boolean {
  if (personalGitHubAccessCovers(accepted.allRepositoriesAccess, access)) return true;
  const listed = accepted.repositories.find((candidate) => sameRepository(candidate, repository));
  return listed !== undefined && personalGitHubAccessCovers(listed.access, access);
}

/**
 * Pure: may this repository be used at `access` under the person's current
 * choice (`current`, read from the database) and, for accepted work, its
 * frozen `accepted` snapshot? In All my repositories the caller must still
 * confirm with GitHub that the person can use the repository (the Git broker
 * and `checkPersonalGitHubRepositoryAccess` do).
 */
export function personalGitHubRepositoryAuthority(input: {
  current: PersonalGitHubRepositorySelectionState;
  metadata: { credentialBindingId: string; providerPrincipalId: string; githubUserId: string };
  accepted?: PersonalGitHubAcceptedRepositorySelection | undefined;
  repository: PersonalGitHubRepositoryLookup;
  access: PersonalGitHubRepositoryAccess;
}): PersonalGitHubRepositoryAuthorityDecision {
  const { current, metadata, accepted, repository, access } = input;
  if (
    current.credentialBindingId !== metadata.credentialBindingId ||
    current.providerPrincipalId !== metadata.providerPrincipalId ||
    metadata.githubUserId !== metadata.providerPrincipalId ||
    (accepted &&
      (current.connectionAuthorityGeneration !== accepted.connectionAuthorityGeneration ||
        current.credentialBindingId !== accepted.credentialBindingId))
  ) {
    return { allowed: false, reason: "connection_changed" };
  }
  if (accepted && !personalGitHubAcceptedSelectionCovers(accepted, repository, access)) {
    return { allowed: false, reason: "outside_accepted_work" };
  }
  if (current.allRepositoriesAccess) {
    if (
      accepted?.allRepositoriesAccess &&
      accepted.selectionGeneration < (current.allRepositoriesGeneration ?? 0)
    ) {
      return { allowed: false, reason: "selection_changed" };
    }
    return personalGitHubAccessCovers(current.allRepositoriesAccess, access)
      ? { allowed: true, mode: "all", allRepositoriesAccess: current.allRepositoriesAccess }
      : { allowed: false, reason: "write_denied" };
  }
  if (accepted && current.selectionGeneration !== accepted.selectionGeneration) {
    return { allowed: false, reason: "selection_changed" };
  }
  const selected = current.repositories.find((candidate) => sameRepository(candidate, repository));
  if (!selected) {
    return { allowed: false, reason: accepted ? "selection_changed" : "not_selected" };
  }
  const listed = accepted?.repositories.find(
    (candidate) => candidate.repositoryId === selected.repositoryId,
  );
  if (
    (repository.repositoryId !== undefined &&
      repository.fullName !== undefined &&
      selected.fullName.toLowerCase() !== repository.fullName.toLowerCase()) ||
    (listed &&
      (listed.fullName !== selected.fullName ||
        listed.canonicalUrl !== selected.canonicalUrl ||
        listed.selectionGeneration !== selected.selectionGeneration))
  ) {
    return { allowed: false, reason: "selection_changed" };
  }
  if (selected.disabled || !canRead(selected.permissions)) {
    return { allowed: false, reason: "read_denied" };
  }
  if (
    access === "write" &&
    (selected.selectedAccess !== "write" || selected.archived || !canWrite(selected.permissions))
  ) {
    return { allowed: false, reason: "write_denied" };
  }
  return { allowed: true, mode: "selected", selected };
}

export type PersonalGitHubRepositoryAccessResult =
  | {
      allowed: true;
      mode: "all" | "selected";
      /** The access this repository gets: the choice, lowered to GitHub's permission. */
      access: PersonalGitHubRepositoryAccess;
      repository: PersonalGitHubRepositoryContract;
      githubLogin: string;
    }
  | { allowed: false; reason: PersonalGitHubRepositoryDenial; message: string };

const DENIAL_MESSAGES: Record<PersonalGitHubRepositoryDenial, string> = {
  connection_unavailable: "Your GitHub connection is unavailable.",
  reconnect_required:
    "GitHub no longer accepts this person's connection. They need to reconnect it in Opengeni.",
  connection_changed: "Your GitHub connection changed. Start a new message to use it again.",
  outside_accepted_work: "This repository is not part of this chat's GitHub access.",
  selection_changed:
    "The repositories Opengeni may use as this person changed. Start a new message to use the new choice.",
  not_selected: "This repository is not one Opengeni may use as this person.",
  not_found: "GitHub has no repository by that name that this person can access.",
  read_denied: "This person cannot read this repository on GitHub.",
  write_denied: "Opengeni may only read this repository as this person.",
  provider_unavailable: "GitHub is temporarily unavailable. Try again.",
};

export function personalGitHubRepositoryDenialMessage(
  reason: PersonalGitHubRepositoryDenial,
): string {
  return DENIAL_MESSAGES[reason];
}

function denied(reason: PersonalGitHubRepositoryDenial): PersonalGitHubRepositoryAccessResult {
  return { allowed: false, reason, message: DENIAL_MESSAGES[reason] };
}

const LIVE_REPOSITORY_CACHE_TTL_MS = 60_000;
const LIVE_REPOSITORY_CACHE_MAX = 1_000;
const LIVE_REPOSITORY_RESPONSE_MAX_BYTES = 256 * 1024;
type LiveRepositoryCacheEntry = {
  expiresAt: number;
  repository: PersonalGitHubRepositoryContract | null;
};
const liveRepositoryCache = new Map<string, LiveRepositoryCacheEntry>();

/** Tests only. */
export function clearPersonalGitHubRepositoryAccessCache(): void {
  liveRepositoryCache.clear();
}

function rememberLiveRepository(key: string, entry: LiveRepositoryCacheEntry): void {
  liveRepositoryCache.delete(key);
  while (liveRepositoryCache.size >= LIVE_REPOSITORY_CACHE_MAX) {
    const oldest = liveRepositoryCache.keys().next().value;
    if (oldest === undefined) break;
    liveRepositoryCache.delete(oldest);
  }
  liveRepositoryCache.set(key, entry);
}

/** GitHub's repository JSON as the credential-free contract shape, or null when it is malformed. */
export function personalGitHubRepositoryFromProvider(
  value: unknown,
): PersonalGitHubRepositoryContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const id = payload.id;
  const repositoryId =
    typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? String(id)
      : typeof id === "string" && /^[1-9]\d*$/u.test(id)
        ? id
        : null;
  const permissions =
    payload.permissions && typeof payload.permissions === "object"
      ? (payload.permissions as Record<string, unknown>)
      : null;
  if (!repositoryId || typeof payload.full_name !== "string" || !permissions) return null;
  const parsed = PersonalGitHubRepository.safeParse({
    repositoryId,
    fullName: payload.full_name,
    canonicalUrl: canonicalPersonalGitHubRepositoryUrl(payload.full_name),
    defaultBranch: payload.default_branch,
    visibility: payload.visibility,
    private: payload.private,
    archived: payload.archived,
    disabled: payload.disabled ?? false,
    permissions: {
      pull: permissions.pull === true,
      push: permissions.push === true,
      admin: permissions.admin === true,
      maintain: permissions.maintain === true,
      triage: permissions.triage === true,
    },
  });
  return parsed.success ? parsed.data : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return JSON.parse(await response.text()) as unknown;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > LIVE_REPOSITORY_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Ask GitHub, as the person, for one repository (cached for a minute per
 * connection authority). Null when GitHub says it does not exist for them.
 * Throws when GitHub cannot answer; that is never cached.
 */
export async function livePersonalGitHubRepository(input: {
  cacheScope: string;
  repository: PersonalGitHubRepositoryLookup;
  githubGet: (url: URL) => Promise<Response>;
  fresh?: boolean | undefined;
  now?: () => number;
}): Promise<PersonalGitHubRepositoryContract | null> {
  const now = input.now ?? Date.now;
  const { repositoryId, fullName } = input.repository;
  const key =
    repositoryId !== undefined
      ? `${input.cacheScope}|id:${repositoryId}`
      : `${input.cacheScope}|name:${(fullName ?? "").toLowerCase()}`;
  const cached = input.fresh ? undefined : liveRepositoryCache.get(key);
  if (cached && cached.expiresAt > now()) return cached.repository;
  let path: string;
  if (repositoryId !== undefined) {
    if (!/^[1-9]\d*$/u.test(repositoryId)) return null;
    path = `/repositories/${repositoryId}`;
  } else {
    const [owner, name, extra] = (fullName ?? "").split("/");
    if (
      !owner ||
      !name ||
      extra !== undefined ||
      !/^[A-Za-z0-9-]{1,39}$/u.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/u.test(name)
    ) {
      return null;
    }
    path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }
  let response = await input.githubGet(new URL(path, PERSONAL_GITHUB_API_ORIGIN));
  // A renamed or transferred repository answers its old name with a redirect
  // to /repositories/<id> on the same API origin; follow that one hop.
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    const target = location ? new URL(location, PERSONAL_GITHUB_API_ORIGIN) : null;
    if (
      !target ||
      target.origin !== PERSONAL_GITHUB_API_ORIGIN ||
      !/^\/repositories\/[1-9]\d*$/u.test(target.pathname)
    ) {
      throw new Error("GitHub redirected the repository lookup elsewhere");
    }
    response = await input.githubGet(new URL(target.pathname, PERSONAL_GITHUB_API_ORIGIN));
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    rememberLiveRepository(key, {
      expiresAt: now() + LIVE_REPOSITORY_CACHE_TTL_MS,
      repository: null,
    });
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`GitHub repository lookup failed (${response.status})`);
  }
  const repository = personalGitHubRepositoryFromProvider(await readBoundedJson(response));
  if (!repository) throw new Error("GitHub returned an invalid repository");
  const entry = { expiresAt: now() + LIVE_REPOSITORY_CACHE_TTL_MS, repository };
  rememberLiveRepository(`${input.cacheScope}|id:${repository.repositoryId}`, entry);
  rememberLiveRepository(`${input.cacheScope}|name:${repository.fullName.toLowerCase()}`, entry);
  return repository;
}

/**
 * May this person's work use this repository at `access` right now?
 *
 * Reads the connection and the person's current choice, applies the
 * accepted snapshot when given (`accepted`, from the turn's delegation), and
 * in All my repositories asks GitHub with `githubGet` (one authorized GET to
 * api.github.com; the caller owns the credential). The answer carries the
 * repository as GitHub (or the saved list) describes it, and the access it
 * actually gets.
 */
export async function checkPersonalGitHubRepositoryAccess(input: {
  db: Database;
  accountId: string;
  originWorkspaceId: string;
  ownerSubjectId: string;
  connectionId: string;
  repository: PersonalGitHubRepositoryLookup;
  access: PersonalGitHubRepositoryAccess;
  accepted?: PersonalGitHubAcceptedRepositorySelection | undefined;
  githubGet: (url: URL) => Promise<Response>;
  /** Skip the brief GitHub cache. */
  fresh?: boolean | undefined;
}): Promise<PersonalGitHubRepositoryAccessResult> {
  if (input.repository.repositoryId === undefined && input.repository.fullName === undefined) {
    return denied("not_found");
  }
  const connection = await getConnectionMetadata(
    input.db,
    input.originWorkspaceId,
    input.connectionId,
    input.ownerSubjectId,
  );
  if (
    !connection ||
    connection.accountId !== input.accountId ||
    connection.workspaceId !== input.originWorkspaceId ||
    connection.subjectId !== input.ownerSubjectId ||
    !isPersonalGitHubConnection(connection)
  ) {
    return denied("connection_unavailable");
  }
  if (personalGitHubConnectionNeedsReconnect(connection)) return denied("reconnect_required");
  if (
    connection.status !== "active" ||
    connection.grantedScopes.length !== 1 ||
    connection.grantedScopes[0] !== "repo"
  ) {
    return denied("connection_unavailable");
  }
  const metadata = PersonalGitHubConnectionMetadata.parse(connection.metadata);
  const current = await getPersonalGitHubRepositorySelectionState(input.db, {
    accountId: input.accountId,
    originWorkspaceId: input.originWorkspaceId,
    subjectId: input.ownerSubjectId,
    connectionId: input.connectionId,
  });
  if (!current) return denied("connection_unavailable");
  const decision = personalGitHubRepositoryAuthority({
    current,
    metadata,
    accepted: input.accepted,
    repository: input.repository,
    access: input.access,
  });
  if (!decision.allowed) return denied(decision.reason);
  if (decision.mode === "selected") {
    const selected = decision.selected;
    return {
      allowed: true,
      mode: "selected",
      access: selected.selectedAccess,
      repository: {
        repositoryId: selected.repositoryId,
        fullName: selected.fullName,
        canonicalUrl: selected.canonicalUrl,
        defaultBranch: selected.defaultBranch,
        visibility: selected.visibility,
        private: selected.private,
        archived: selected.archived,
        disabled: selected.disabled,
        permissions: selected.permissions,
      },
      githubLogin: metadata.githubLogin,
    };
  }
  let repository: PersonalGitHubRepositoryContract | null;
  try {
    repository = await livePersonalGitHubRepository({
      cacheScope: `${input.connectionId}|${current.connectionAuthorityGeneration}|${current.credentialBindingId}`,
      repository: input.repository,
      githubGet: input.githubGet,
      fresh: input.fresh,
    });
  } catch {
    return denied("provider_unavailable");
  }
  if (
    !repository ||
    (input.repository.fullName !== undefined &&
      input.repository.repositoryId !== undefined &&
      repository.fullName.toLowerCase() !== input.repository.fullName.toLowerCase())
  ) {
    return denied("not_found");
  }
  const access = personalGitHubAllRepositoriesEffectiveAccess(
    decision.allRepositoriesAccess,
    repository,
  );
  if (!access) return denied("read_denied");
  if (!personalGitHubAccessCovers(access, input.access)) return denied("write_denied");
  return { allowed: true, mode: "all", access, repository, githubLogin: metadata.githubLogin };
}
