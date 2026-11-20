import {
  classifySessionLinkUrl,
  parseGitHubLinkRef,
  type SessionLink,
  type SessionLinkLiveStatus,
  type SessionLinkWithStatus,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { listGitHubInstallationAccessForWorkspace } from "@opengeni/db";
import {
  createGitHubAppInstallationTokenWithExpiry,
  getGitHubAppInstallationRepository,
  githubAppMissingSettings,
} from "@opengeni/github";

/**
 * Live status for a chat's Linked items. A GitHub pull request or issue is
 * read through the workspace's GitHub App, the GitHub connection everyone in
 * the workspace shares, and only for repositories the workspace chose for it.
 * Every other link, and any GitHub link the App cannot read, shows its title
 * only (`status: null`). Reads are bounded, cached briefly and never fail the
 * list: a slow or refusing GitHub leaves that one link without status.
 */

const STATUS_TTL_MS = 30_000;
const TOKEN_REUSE_MARGIN_MS = 60_000;
const GITHUB_TIMEOUT_MS = 6_000;
const MAX_CONCURRENT = 4;
const GITHUB_API = "https://api.github.com";

type CachedStatus = { at: number; status: SessionLinkLiveStatus | null };
const statusCache = new Map<string, CachedStatus>();
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

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

/** A REST reader for one repository through the workspace's GitHub App, or null. */
async function workspaceGitHubReader(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<GitHubRead | null> {
  if (githubAppMissingSettings(deps.settings).length > 0) return null;
  const key = `${workspaceId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  let cached = tokenCache.get(key);
  if (!cached || cached.expiresAt - TOKEN_REUSE_MARGIN_MS < Date.now()) {
    const installations = await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId);
    const installation = installations.find(
      (each) => each.accountLogin?.toLowerCase() === owner.toLowerCase(),
    );
    if (!installation) return null;
    const repository = await getGitHubAppInstallationRepository(deps.settings, {
      installationId: installation.installationId,
      owner,
      name: repo,
    });
    if (!repository) return null;
    // Only repositories the workspace chose for its GitHub App.
    if (
      installation.repositoryScope !== "all" &&
      !installation.repositoryIds.includes(repository.id)
    ) {
      return null;
    }
    const minted = await createGitHubAppInstallationTokenWithExpiry(deps.settings, {
      installationId: installation.installationId,
      repositoryIds: [repository.id],
    });
    cached = {
      token: minted.token,
      expiresAt: minted.expiresAt ? Date.parse(minted.expiresAt) : Date.now() + 10 * 60_000,
    };
    tokenCache.set(key, cached);
  }
  const token = cached.token;
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

/** Each link with its live status, read with bounded concurrency and a short cache. */
export async function withSessionLinkStatuses(
  workspaceId: string,
  links: readonly SessionLink[],
  reader: SessionLinkStatusReader,
  options: { fresh?: boolean } = {},
): Promise<SessionLinkWithStatus[]> {
  const results: SessionLinkWithStatus[] = links.map((link) => ({ ...link, status: null }));
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      const link = links[index]!;
      const key = `${workspaceId}:${link.url}`;
      const cached = statusCache.get(key);
      if (!options.fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
        results[index] = { ...link, status: cached.status };
        continue;
      }
      const status = await reader(workspaceId, link).catch(() => null);
      statusCache.set(key, { at: Date.now(), status });
      if (statusCache.size > 2_000) statusCache.delete(statusCache.keys().next().value!);
      results[index] = { ...link, status };
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, links.length) }, worker));
  return results;
}
