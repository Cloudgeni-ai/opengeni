import {
  classifySessionLinkUrl,
  parseGitHubLinkRef,
  type SessionLink,
  type SessionLinkConnect,
  type SessionLinkLiveStatus,
  type SessionLinkWithStatus,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { listGitHubInstallationAccessForWorkspace } from "@opengeni/db";
import { viewerLinkProvider, type ViewerLinkRead } from "./session-link-viewer-status";
import {
  createGitHubAppInstallationTokenWithExpiry,
  getGitHubAppInstallationRepository,
  githubAppMissingSettings,
} from "@opengeni/github";

/**
 * Live status for a chat's Linked items. A GitHub pull request or issue is
 * read through the workspace's GitHub App, the GitHub connection everyone in
 * the workspace shares, and only for repositories the workspace chose for it.
 * A Linear issue or Slack thread is read as the viewer through their own (or a
 * workspace-shared) connection, cached per viewer; without one the link
 * carries `connect`. Every other link, and any link that can't be read, shows
 * its title only (`status: null`). Reads are bounded, cached briefly and never
 * fail the list: a slow or refusing provider leaves that one link without
 * status.
 */

const STATUS_TTL_MS = 30_000;
/**
 * Viewer reads (Linear, Slack) go through each viewer's connection gateway,
 * so they're kept longer; an explicit refresh still re-reads them.
 */
const VIEWER_STATUS_TTL_MS = 120_000;
/** A viewer read that found nothing (failed, timed out) is tried again soon. */
const VIEWER_MISS_TTL_MS = 10_000;
/** Even an explicit refresh re-reads one link at most this often. */
const FRESH_MIN_INTERVAL_MS = 5_000;
const TOKEN_REUSE_MARGIN_MS = 60_000;
const REPOSITORY_TTL_MS = 10 * 60_000;
const NOT_FOUND_TTL_MS = 30_000;
const GITHUB_TIMEOUT_MS = 6_000;
const MAX_CONCURRENT = 4;
const CACHE_MAX = 2_000;
const GITHUB_API = "https://api.github.com";

type CachedStatus = {
  at: number;
  status: SessionLinkLiveStatus | null;
  connect?: SessionLinkConnect | null;
};
type ResolvedRepository = { installationId: number; repositoryId: number; fullName: string };
const statusCache = new Map<string, CachedStatus>();
// Repository metadata (installation, id, canonical name) only; whether the
// workspace may read it is re-checked on every read.
const repositoryCache = new Map<string, { at: number; repository: ResolvedRepository | null }>();
// Tokens per installation and repository; a concurrent read shares one mint.
const tokenCache = new Map<string, Promise<{ token: string; expiresAt: number }>>();

function boundedSet<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export type GitHubRead = (path: string) => Promise<unknown>;

/** Checks summary from check runs and the combined commit status. */
export function summarizeGitHubChecks(
  checkRuns: readonly { status?: unknown; conclusion?: unknown }[],
  combinedState: unknown,
  statusCount: number,
): SessionLinkLiveStatus["checks"] {
  if (checkRuns.length === 0 && statusCount === 0) return "none";
  const failed = new Set([
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
  ]);
  if (
    checkRuns.some((run) => failed.has(String(run.conclusion))) ||
    combinedState === "failure" ||
    combinedState === "error"
  ) {
    return "failing";
  }
  if (
    checkRuns.some((run) => run.status !== "completed") ||
    (statusCount > 0 && combinedState === "pending")
  ) {
    return "pending";
  }
  return "passing";
}

/** Review state from the reviews list: each reviewer's latest decisive review counts. */
export function summarizeGitHubReviews(
  reviews: readonly { state?: unknown; user?: { login?: unknown } | null }[],
  requestedReviewers: number,
): SessionLinkLiveStatus["review"] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const state = String(review.state ?? "");
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") continue;
    latest.set(String(review.user?.login ?? ""), state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return requestedReviewers > 0 ? "review_required" : "none";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function title(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

/** A pull request's live status, from GitHub's REST API through `read`. */
export async function readGitHubPullRequestStatus(
  read: GitHubRead,
  ref: { owner: string; repo: string; number: number },
): Promise<SessionLinkLiveStatus> {
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const pull = record(await read(`${base}/pulls/${ref.number}`));
  const merged = pull.merged === true || typeof pull.merged_at === "string";
  const state = merged
    ? "merged"
    : pull.state === "closed"
      ? "closed"
      : pull.draft === true
        ? "draft"
        : "open";
  const sha = typeof record(pull.head).sha === "string" ? (record(pull.head).sha as string) : null;
  let checks: SessionLinkLiveStatus["checks"] = null;
  let review: SessionLinkLiveStatus["review"] = null;
  if (state === "open" || state === "draft") {
    const [runs, combined, reviews] = await Promise.all([
      sha ? read(`${base}/commits/${sha}/check-runs?per_page=100`).catch(() => null) : null,
      sha ? read(`${base}/commits/${sha}/status`).catch(() => null) : null,
      read(`${base}/pulls/${ref.number}/reviews?per_page=100`).catch(() => null),
    ]);
    if (runs || combined) {
      const checkRuns = Array.isArray(record(runs).check_runs)
        ? (record(runs).check_runs as Record<string, unknown>[])
        : [];
      const statuses = Array.isArray(record(combined).statuses)
        ? (record(combined).statuses as unknown[]).length
        : 0;
      checks = summarizeGitHubChecks(checkRuns, record(combined).state, statuses);
    }
    if (Array.isArray(reviews)) {
      const requested = Array.isArray(pull.requested_reviewers)
        ? pull.requested_reviewers.length
        : 0;
      review = summarizeGitHubReviews(reviews as Record<string, never>[], requested);
    }
  }
  return { state, label: null, title: title(pull.title), checks, review };
}

/** An issue's live status. */
export async function readGitHubIssueStatus(
  read: GitHubRead,
  ref: { owner: string; repo: string; number: number },
): Promise<SessionLinkLiveStatus> {
  const issue = record(
    await read(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`,
    ),
  );
  const state = issue.state === "closed" ? "done" : "open";
  return { state, label: null, title: title(issue.title), checks: null, review: null };
}

/**
 * The repository through the workspace's GitHub App, with its canonical
 * `owner/name`, or null when the workspace has no App installation that may
 * read it. The workspace's installations and repository choice are checked on
 * every call, so removing a repository or the App takes effect at once.
 */
export async function resolveWorkspaceGitHubRepository(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  workspaceId: string,
  owner: string,
  repo: string,
  io: {
    listInstallations: typeof listGitHubInstallationAccessForWorkspace;
    lookupRepository: typeof getGitHubAppInstallationRepository;
  } = {
    listInstallations: listGitHubInstallationAccessForWorkspace,
    lookupRepository: getGitHubAppInstallationRepository,
  },
): Promise<ResolvedRepository | null> {
  if (githubAppMissingSettings(deps.settings).length > 0) return null;
  const installations = await io.listInstallations(deps.db, workspaceId);
  const installation = installations.find(
    (each) => each.accountLogin?.toLowerCase() === owner.toLowerCase(),
  );
  if (!installation) return null;
  const key = `${installation.installationId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  let cached = repositoryCache.get(key);
  // A repository not found is re-checked soon: the App may be installed on it next.
  const ttl = cached?.repository ? REPOSITORY_TTL_MS : NOT_FOUND_TTL_MS;
  if (!cached || Date.now() - cached.at > ttl) {
    const found = await io.lookupRepository(deps.settings, {
      installationId: installation.installationId,
      owner,
      name: repo,
    });
    cached = {
      at: Date.now(),
      repository: found
        ? {
            installationId: installation.installationId,
            repositoryId: found.id,
            fullName: found.fullName,
          }
        : null,
    };
    boundedSet(repositoryCache, key, cached);
  }
  const repository = cached.repository;
  if (!repository) return null;
  // Only repositories the workspace chose for its GitHub App.
  if (
    installation.repositoryScope !== "all" &&
    !installation.repositoryIds.includes(repository.repositoryId)
  ) {
    return null;
  }
  return repository;
}

async function installationToken(
  deps: Pick<ApiRouteDeps, "settings">,
  repository: ResolvedRepository,
): Promise<string> {
  const key = `${repository.installationId}:${repository.repositoryId}`;
  const cached = tokenCache.get(key);
  if (cached) {
    const token = await cached.catch(() => null);
    if (token && token.expiresAt - TOKEN_REUSE_MARGIN_MS > Date.now()) return token.token;
    if (tokenCache.get(key) === cached) tokenCache.delete(key);
  }
  const pending = createGitHubAppInstallationTokenWithExpiry(deps.settings, {
    installationId: repository.installationId,
    repositoryIds: [repository.repositoryId],
  }).then((minted) => ({
    token: minted.token,
    expiresAt: minted.expiresAt ? Date.parse(minted.expiresAt) : Date.now() + 10 * 60_000,
  }));
  pending.catch(() => {
    if (tokenCache.get(key) === pending) tokenCache.delete(key);
  });
  boundedSet(tokenCache, key, pending);
  return (await pending).token;
}

/** A REST reader for one repository through the workspace's GitHub App, or null. */
async function workspaceGitHubReader(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<GitHubRead | null> {
  const repository = await resolveWorkspaceGitHubRepository(deps, workspaceId, owner, repo);
  if (!repository) return null;
  const token = await installationToken(deps, repository);
  return async (path) => {
    const response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "opengeni",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json();
  };
}

/**
 * What a merge or release wake for a GitHub link needs: the repository's
 * canonical name (event conditions compare exactly) and, for a pull request,
 * its current state. Null when the workspace's GitHub App cannot read it, so
 * its events would not reach the chat either.
 */
export async function sessionLinkGitHubWakeTarget(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  workspaceId: string,
  link: Pick<SessionLink, "url" | "ref" | "kind">,
): Promise<{ fullName: string; state: SessionLinkLiveStatus["state"] | null } | null> {
  const ref = classifySessionLinkUrl(link.url)?.github ?? parseGitHubLinkRef(link.ref);
  if (!ref) return null;
  const repository = await resolveWorkspaceGitHubRepository(
    deps,
    workspaceId,
    ref.owner,
    ref.repo,
  ).catch(() => null);
  if (!repository) return null;
  let state: SessionLinkLiveStatus["state"] | null = null;
  if (link.kind === "pull_request") {
    const read = await workspaceGitHubReader(deps, workspaceId, ref.owner, ref.repo).catch(
      () => null,
    );
    state = read
      ? ((await readGitHubPullRequestStatus(read, ref).catch(() => null))?.state ?? null)
      : null;
  }
  return { fullName: repository.fullName, state };
}

export type SessionLinkStatusReader = (
  workspaceId: string,
  link: SessionLink,
) => Promise<SessionLinkLiveStatus | null>;

/** The default reader: GitHub through the workspace App; everything else title only. */
export function workspaceSessionLinkStatusReader(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
): SessionLinkStatusReader {
  return async (workspaceId, link) => {
    if (link.provider !== "github") return null;
    const classified = classifySessionLinkUrl(link.url);
    const ref = classified?.github ?? parseGitHubLinkRef(link.ref);
    if (!ref) return null;
    const read = await workspaceGitHubReader(deps, workspaceId, ref.owner, ref.repo);
    if (!read) return null;
    return link.kind === "issue"
      ? await readGitHubIssueStatus(read, ref)
      : await readGitHubPullRequestStatus(read, ref);
  };
}

/**
 * Reads Linear issues and Slack threads as the viewer (see
 * `session-link-viewer-status.ts`); cached per viewer, never shared.
 */
export type SessionLinkViewerReader = {
  subjectId: string;
  read: (link: SessionLink) => Promise<ViewerLinkRead>;
};

/** Each link with its live status, read with bounded concurrency and a short cache. */
export async function withSessionLinkStatuses(
  workspaceId: string,
  links: readonly SessionLink[],
  reader: SessionLinkStatusReader,
  options: { fresh?: boolean; viewer?: SessionLinkViewerReader | null } = {},
): Promise<SessionLinkWithStatus[]> {
  const results: SessionLinkWithStatus[] = links.map((link) => ({ ...link, status: null }));
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      const link = links[index]!;
      const viewer = viewerLinkProvider(link) ? (options.viewer ?? null) : null;
      // Read as the viewer: the cache is theirs alone.
      const key = viewer
        ? `${workspaceId}:viewer:${viewer.subjectId}:${link.url}`
        : `${workspaceId}:${link.url}`;
      const cached = statusCache.get(key);
      const maxAge = options.fresh
        ? FRESH_MIN_INTERVAL_MS
        : viewer
          ? cached?.status || cached?.connect
            ? VIEWER_STATUS_TTL_MS
            : VIEWER_MISS_TTL_MS
          : STATUS_TTL_MS;
      if (cached && Date.now() - cached.at < maxAge) {
        results[index] = withRead(link, cached);
        continue;
      }
      let entry: CachedStatus;
      if (viewer) {
        const read = await viewer.read(link).catch((): ViewerLinkRead => ({ kind: "none" }));
        entry = {
          at: Date.now(),
          status: read.kind === "status" ? read.status : null,
          connect: read.kind === "connect" ? read.connect : null,
        };
      } else {
        entry = { at: Date.now(), status: await reader(workspaceId, link).catch(() => null) };
      }
      boundedSet(statusCache, key, entry);
      results[index] = withRead(link, entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, links.length) }, worker));
  return results;
}

function withRead(link: SessionLink, read: CachedStatus): SessionLinkWithStatus {
  return { ...link, status: read.status, ...(read.connect ? { connect: read.connect } : {}) };
}
