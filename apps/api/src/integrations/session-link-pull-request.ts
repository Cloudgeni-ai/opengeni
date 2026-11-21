import {
  classifySessionLinkUrl,
  parseGitHubLinkRef,
  type GitDiffHunk,
  type GitDiffLine,
  type GitFileDiff,
  type SessionLink,
  type SessionLinkLiveStatus,
} from "@opengeni/contracts";
import { personalGitHubReader, type ApiRouteDeps } from "@opengeni/core";
import {
  type GitHubRead,
  summarizeGitHubChecks,
  summarizeGitHubReviews,
  workspaceGitHubReader,
} from "./session-link-status";

/**
 * A linked pull request in full, for the chat's PR panel: its header facts,
 * description, changed files (as structured hunks the workbench diff renders),
 * commits, discussion and checks. Read through the same workspace GitHub App
 * as the Linked status, so the same repositories are readable; null when the
 * workspace cannot read it. Lists are bounded to one GitHub page each.
 */
export type SessionPullRequestDetail = {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  author: SessionPullRequestPerson | null;
  base: string;
  head: string;
  createdAt: string | null;
  mergedAt: string | null;
  body: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  commentCount: number;
  /** GitHub's mergeability (null while it computes). */
  mergeable: boolean | null;
  checks: SessionLinkLiveStatus["checks"];
  review: SessionLinkLiveStatus["review"];
  files: GitFileDiff[];
  /** More files changed than are listed. */
  filesTruncated: boolean;
  commits: SessionPullRequestCommit[];
  comments: SessionPullRequestComment[];
  checkRuns: SessionPullRequestCheckRun[];
};

export type SessionPullRequestPerson = { login: string; avatarUrl: string | null };
export type SessionPullRequestCommit = {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
};
export type SessionPullRequestComment = {
  id: string;
  kind: "comment" | "review";
  author: SessionPullRequestPerson | null;
  body: string;
  /** A review's verdict: approved, changes_requested or commented. */
  reviewState: "approved" | "changes_requested" | "commented" | null;
  createdAt: string | null;
  url: string | null;
};
export type SessionPullRequestCheckRun = {
  name: string;
  /** passing, failing, pending, or skipped. */
  state: "passing" | "failing" | "pending" | "skipped";
  url: string | null;
};

const PER_PAGE = 100;
const BODY_MAX = 20_000;
const COMMENT_MAX = 8_000;
/** A file patch larger than this shows as "too large" rather than inline. */
const PATCH_MAX = 200_000;
/** Patch text kept per pull request; later files show as too large. */
const PATCH_BUDGET = 1_000_000;
const DETAIL_TTL_MS = 30_000;
const FRESH_MIN_INTERVAL_MS = 5_000;
/** A failed read is retried soon, not held for the full TTL. */
const FAILURE_TTL_MS = 5_000;
const CACHE_MAX = 50;

const detailCache = new Map<
  string,
  { at: number; failed?: boolean; detail: Promise<SessionPullRequestDetail | null> }
>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function person(value: unknown): SessionPullRequestPerson | null {
  const user = record(value);
  const login = text(user.login, 100);
  return login ? { login, avatarUrl: text(user.avatar_url, 500) } : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

const BINARY_PATH =
  /\.(png|jpe?g|gif|webp|ico|bmp|avif|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|jar|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|webm|wav|ogg|exe|dll|so|dylib|bin|class|pyc)$/i;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** GitHub's per-file `patch` (hunks only, no file header) as structured hunks. */
export function parseGitHubPatch(patch: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  let hunk: GitDiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      hunk = {
        oldStart: oldNo,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newNo,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        header: header[5]?.trim() ?? "",
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = raw[0];
    let line: GitDiffLine;
    if (marker === "+") {
      line = { type: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) };
    } else if (marker === "-") {
      line = { type: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) };
    } else if (marker === "\\") {
      line = { type: "meta", oldNo: null, newNo: null, text: raw };
    } else if (marker === " " || raw === "") {
      // A trailing empty string is the split after the final newline.
      if (raw === "" && oldNo >= hunk.oldStart + hunk.oldLines) continue;
      line = { type: "context", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) };
    } else {
      continue;
    }
    hunk.lines.push(line);
  }
  return hunks;
}

function fileStatus(status: unknown): GitFileDiff["status"] {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "modified";
  }
}

function fileDiff(file: Record<string, unknown>, budget: { left: number }): GitFileDiff {
  const path = text(file.filename, 4096) ?? "";
  const patch = typeof file.patch === "string" ? file.patch : null;
  const tooLarge = patch !== null && (patch.length > PATCH_MAX || patch.length > budget.left);
  if (patch !== null && !tooLarge) budget.left -= patch.length;
  // GitHub sends no patch for binary files; an empty or mode-only change also
  // has none, so only a known binary type reads as binary.
  const isBinary =
    patch === null &&
    count(file.changes) === 0 &&
    file.status !== "renamed" &&
    BINARY_PATH.test(path);
  return {
    path,
    oldPath: text(file.previous_filename, 4096),
    status: fileStatus(file.status),
    isBinary,
    isImage: /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(path),
    additions: count(file.additions),
    deletions: count(file.deletions),
    hunks: patch && !tooLarge ? parseGitHubPatch(patch) : [],
    // GitHub omits the patch of a very large file: show it as too large.
    truncated: tooLarge || (patch === null && !isBinary && count(file.changes) > 0),
  };
}

function checkRunState(run: Record<string, unknown>): SessionPullRequestCheckRun["state"] {
  if (run.status !== "completed") return "pending";
  const conclusion = String(run.conclusion ?? "");
  // Matches summarizeGitHubChecks: only these conclusions fail.
  if (FAILED_CONCLUSIONS.has(conclusion)) return "failing";
  if (conclusion === "skipped") return "skipped";
  return "passing";
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

function reviewState(state: unknown): SessionPullRequestComment["reviewState"] {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  return "commented";
}

/** The pull request's details from GitHub's REST API through `read`. */
export async function readGitHubPullRequestDetail(
  read: GitHubRead,
  ref: { owner: string; repo: string; number: number },
): Promise<SessionPullRequestDetail> {
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const pull = record(await read(`${base}/pulls/${ref.number}`));
  const headSha = text(record(pull.head).sha, 80);
  const optional = (path: string) => read(path).catch(() => null);
  const [files, commits, issueComments, reviews, runs, combined] = await Promise.all([
    optional(`${base}/pulls/${ref.number}/files?per_page=${PER_PAGE}`),
    optional(`${base}/pulls/${ref.number}/commits?per_page=${PER_PAGE}`),
    optional(`${base}/issues/${ref.number}/comments?per_page=${PER_PAGE}`),
    optional(`${base}/pulls/${ref.number}/reviews?per_page=${PER_PAGE}`),
    headSha ? optional(`${base}/commits/${headSha}/check-runs?per_page=${PER_PAGE}`) : null,
    headSha ? optional(`${base}/commits/${headSha}/status`) : null,
  ]);
  const merged = pull.merged === true || typeof pull.merged_at === "string";
  const state = merged
    ? "merged"
    : pull.state === "closed"
      ? "closed"
      : pull.draft === true
        ? "draft"
        : "open";
  const checkRuns = list(record(runs).check_runs);
  const statuses = list(record(combined).statuses);
  const reviewList = list(reviews);
  const comments: SessionPullRequestComment[] = [
    ...list(issueComments).map(
      (comment): SessionPullRequestComment => ({
        id: `comment:${String(comment.id ?? "")}`,
        kind: "comment",
        author: person(comment.user),
        body: text(comment.body, COMMENT_MAX) ?? "",
        reviewState: null,
        createdAt: text(comment.created_at, 40),
        url: text(comment.html_url, 2048),
      }),
    ),
    // A review counts as discussion when it says something or decides.
    ...reviewList
      .filter((review) => text(review.body) !== null || review.state !== "COMMENTED")
      .filter((review) => review.state !== "PENDING" && review.state !== "DISMISSED")
      .map(
        (review): SessionPullRequestComment => ({
          id: `review:${String(review.id ?? "")}`,
          kind: "review",
          author: person(review.user),
          body: text(review.body, COMMENT_MAX) ?? "",
          reviewState: reviewState(review.state),
          createdAt: text(review.submitted_at, 40),
          url: text(review.html_url, 2048),
        }),
      ),
  ].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const budget = { left: PATCH_BUDGET };
  const fileList = list(files).map((file) => fileDiff(file, budget));
  const changedFiles = count(pull.changed_files);
  return {
    url:
      text(pull.html_url, 2048) ?? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: text(pull.title, 300) ?? `#${ref.number}`,
    state,
    author: person(pull.user),
    base: text(record(pull.base).ref, 255) ?? "",
    head: text(record(pull.head).ref, 255) ?? "",
    createdAt: text(pull.created_at, 40),
    mergedAt: text(pull.merged_at, 40),
    body: text(pull.body, BODY_MAX),
    additions: count(pull.additions),
    deletions: count(pull.deletions),
    changedFiles,
    commitCount: count(pull.commits),
    commentCount: count(pull.comments) + reviewList.length,
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
    checks:
      runs || combined
        ? summarizeGitHubChecks(checkRuns, record(combined).state, statuses.length)
        : null,
    review: Array.isArray(reviews)
      ? summarizeGitHubReviews(
          reviewList as Record<string, never>[],
          Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers.length : 0,
        )
      : null,
    files: fileList,
    filesTruncated: changedFiles > fileList.length,
    commits: list(commits).map((commit) => {
      const detail = record(commit.commit);
      return {
        sha: text(commit.sha, 80) ?? "",
        message: text(detail.message, 2000) ?? "",
        author: person(commit.author)?.login ?? text(record(detail.author).name, 100),
        date: text(record(detail.author).date, 40),
      };
    }),
    comments,
    checkRuns: [
      ...checkRuns.map((run) => ({
        name: text(run.name, 200) ?? "check",
        state: checkRunState(run),
        url: text(run.html_url, 2048) ?? text(run.details_url, 2048),
      })),
      ...statuses.map((status) => ({
        name: text(status.context, 200) ?? "status",
        state:
          status.state === "success"
            ? ("passing" as const)
            : status.state === "pending"
              ? ("pending" as const)
              : ("failing" as const),
        url: text(status.target_url, 2048),
      })),
    ],
  };
}

export type SessionPullRequestReader = (
  workspaceId: string,
  link: SessionLink,
) => Promise<SessionPullRequestDetail | null>;

/** A person's own GitHub connection, used when the workspace's App can't read the repository. */
export type SessionPullRequestViewer = {
  subjectId: string;
  read: SessionPullRequestReader;
};

function pullRequestRef(link: SessionLink) {
  if (link.provider !== "github" || link.kind !== "pull_request") return null;
  return classifySessionLinkUrl(link.url)?.github ?? parseGitHubLinkRef(link.ref) ?? null;
}

/**
 * The default reader: through the workspace's GitHub App, like the Linked
 * status. Null when the App can't read the repository; a failed read throws.
 */
export function workspaceSessionPullRequestReader(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
): SessionPullRequestReader {
  return async (workspaceId, link) => {
    const ref = pullRequestRef(link);
    if (!ref) return null;
    const read = await workspaceGitHubReader(deps, workspaceId, ref.owner, ref.repo);
    if (!read) return null;
    return await readGitHubPullRequestDetail(read, ref);
  };
}

/** The viewer's own GitHub (Your GitHub), for repositories they let Opengeni use. */
export function personalSessionPullRequestReader(
  deps: Pick<ApiRouteDeps, "db" | "settings" | "githubPersonalFetch">,
  viewer: { accountId: string; workspaceId: string; subjectId: string },
): SessionPullRequestReader {
  return async (_workspaceId, link) => {
    const ref = pullRequestRef(link);
    if (!ref) return null;
    const read = await personalGitHubReader(
      { db: deps.db, settings: deps.settings, fetch: deps.githubPersonalFetch },
      { ...viewer, repository: `${ref.owner}/${ref.repo}` },
    ).catch(() => null);
    if (!read) return null;
    return await readGitHubPullRequestDetail(read, ref);
  };
}

async function cachedRead(
  key: string,
  read: () => Promise<SessionPullRequestDetail | null>,
  fresh: boolean,
): Promise<SessionPullRequestDetail | null> {
  const cached = detailCache.get(key);
  const maxAge = cached?.failed ? FAILURE_TTL_MS : fresh ? FRESH_MIN_INTERVAL_MS : DETAIL_TTL_MS;
  if (cached && Date.now() - cached.at < maxAge) return await cached.detail;
  const entry: { at: number; failed?: boolean; detail: Promise<SessionPullRequestDetail | null> } =
    { at: Date.now(), detail: read() };
  entry.detail.catch(() => {
    entry.failed = true;
  });
  detailCache.delete(key);
  detailCache.set(key, entry);
  while (detailCache.size > CACHE_MAX) detailCache.delete(detailCache.keys().next().value!);
  return await entry.detail;
}

/**
 * The detail with a short shared cache; `fresh` re-reads at most every few
 * seconds. When the workspace can't read it, the viewer's own GitHub is
 * tried, cached for that viewer alone. A failed GitHub read rejects (and is
 * retried soon) so it never reads as "can't read this pull request".
 */
export async function cachedSessionPullRequestDetail(
  workspaceId: string,
  link: SessionLink,
  reader: SessionPullRequestReader,
  options: { fresh?: boolean; viewer?: SessionPullRequestViewer | null } = {},
): Promise<SessionPullRequestDetail | null> {
  const fresh = options.fresh === true;
  const shared = await cachedRead(
    `${workspaceId}:${link.url}`,
    () => reader(workspaceId, link),
    fresh,
  );
  if (shared || !options.viewer) return shared;
  const viewer = options.viewer;
  return await cachedRead(
    `${workspaceId}:viewer:${viewer.subjectId}:${link.url}`,
    () => viewer.read(workspaceId, link),
    fresh,
  );
}
