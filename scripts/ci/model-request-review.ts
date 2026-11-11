#!/usr/bin/env bun
// Model request review gate.
//
// Changes to what Opengeni sends to model providers land only with an
// approving review by the maintainer on the PR's current head commit. The
// guarded paths are the model request section of `.github/CODEOWNERS`.
//
// The pure checks below are shared by the merge batcher
// (`scripts/batcher/pass.ts`), which never batches or lands a PR that fails
// them, and by this file's command line, which
// `.github/workflows/model-request-review.yml` runs from `main` to report the
// "Model request review" status on the PR, re-request the maintainer's review
// and keep one comment that lists the guarded files the PR changes.
// See docs/merge-batcher.md, "Model request review".
//
// Imports only Node built-ins: the batcher checks this file out alone.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const MAINTAINER = "jorgensandhaug";
export const STATUS_CONTEXT = "Model request review";
/**
 * GitHub does not let a PR's author approve it. On a PR the maintainer
 * authored, a review he submits on the head commit whose first line is this
 * command stands for his approval.
 */
export const SELF_APPROVAL_COMMAND = "/approve-model-request";
export const SECTION_BEGIN = "# BEGIN model request review";
export const SECTION_END = "# END model request review";
export const COMMENT_MARKER = "<!-- model-request-review -->";
export const CODEOWNERS_URL = new URL("../../.github/CODEOWNERS", import.meta.url);

/**
 * The guarded path patterns: the lines between the section markers of a
 * CODEOWNERS file. Throws unless the section exists, is the last thing in the
 * file (CODEOWNERS applies the last matching line, so a later line could hand
 * a guarded path to another owner), and every line is a root-anchored pattern
 * owned by the maintainer alone.
 */
export function guardedPatterns(codeowners: string): string[] {
  const lines = codeowners.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.indexOf(SECTION_BEGIN);
  const end = lines.indexOf(SECTION_END);
  if (begin < 0 || end < begin) throw new Error(`CODEOWNERS has no "${SECTION_BEGIN}" section`);
  if (lines.slice(end + 1).some((line) => line && !line.startsWith("#")))
    throw new Error("The model request review section must be the last one in CODEOWNERS");
  const patterns: string[] = [];
  for (const line of lines.slice(begin + 1, end)) {
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (owners.length !== 1 || owners[0]!.toLowerCase() !== `@${MAINTAINER}`)
      throw new Error(`CODEOWNERS line "${line}" must be owned by @${MAINTAINER} alone`);
    if (!pattern!.startsWith("/") || /[\\![\]]/.test(pattern!) || pattern === "/")
      throw new Error(`CODEOWNERS pattern "${pattern}" must be a path from the repository root`);
    patterns.push(pattern!);
  }
  if (!patterns.length) throw new Error("The model request review section names no paths");
  return patterns;
}

/** Read the guarded patterns from a CODEOWNERS file (by default the one beside this file). */
export function loadGuardedPatterns(path: string | URL = CODEOWNERS_URL): string[] {
  return guardedPatterns(readFileSync(path, "utf8"));
}

/**
 * A root-anchored CODEOWNERS pattern as a regular expression over repository
 * paths: `*` and `?` stay within one path segment, `**` crosses segments, a
 * trailing `/` names a directory and everything below it, and a literal path
 * names that file or everything below that directory. A wildcard last
 * segment matches only at that level, as GitHub documents (`/docs/*` does
 * not match `docs/a/b.md`).
 */
export function patternRegExp(pattern: string): RegExp {
  let body = pattern.replace(/^\//, "");
  const directory = body.endsWith("/");
  if (directory) body = body.slice(0, -1);
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === "*" && body[i + 1] === "*") {
      if (body[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const last = body.slice(body.lastIndexOf("/") + 1);
  const tail = directory ? "/" : /[*?]/.test(last) ? "$" : "(?:/|$)";
  return new RegExp(`^${source}${tail}`);
}

/** The changed files (sorted, unique) that a guarded pattern covers. */
export function guardedFiles(patterns: string[], files: string[]): string[] {
  const expressions = patterns.map(patternRegExp);
  return [...new Set(files)].filter((file) => expressions.some((e) => e.test(file))).sort();
}

/** One submitted PR review, as the REST API reports it. */
export interface Review {
  login: string | null;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  /** The head commit the review was submitted on. */
  commitId: string | null;
  body: string | null;
  /** Epoch milliseconds; null for a pending review. */
  submittedAt: number | null;
}

const isMaintainer = (login: string | null | undefined) => login?.toLowerCase() === MAINTAINER;

function isSelfApproval(body: string | null): boolean {
  const first = (body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first?.toLowerCase().split(/\s+/)[0] === SELF_APPROVAL_COMMAND;
}

/**
 * Whether the maintainer's latest decisive review on exactly `headSha`
 * approves it. Reviews on earlier commits, dismissed approvals, pending
 * reviews and anyone else's reviews never count; a later "changes requested"
 * revokes an approval, and so does a later dismissed one (dismissing his
 * "changes requested" never brings an earlier approval back). On his own PR,
 * where GitHub refuses self-approval, a comment review on the head whose
 * first line is the self-approval command counts as approving.
 */
export function approvedOnHead(
  reviews: Review[],
  headSha: string,
  author: string | null | undefined,
): boolean {
  const own = reviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => isMaintainer(review.login) && review.commitId === headSha)
    .filter(({ review }) => review.submittedAt !== null)
    .sort((a, b) => a.review.submittedAt! - b.review.submittedAt! || a.index - b.index);
  let approved = false;
  for (const { review } of own) {
    if (review.state === "APPROVED") approved = true;
    else if (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") approved = false;
    else if (review.state === "COMMENTED" && isMaintainer(author) && isSelfApproval(review.body))
      approved = true;
  }
  return approved;
}

export interface Verdict {
  /** Guarded files the PR changes; null when GitHub lists too many files to tell. */
  guarded: string[] | null;
  /** The PR needs the maintainer's approval: it changes guarded files, or may. */
  needsApproval: boolean;
  approved: boolean;
  /** It may land as far as this gate is concerned. */
  pass: boolean;
}

/**
 * The gate's verdict. `files` are the PR's changed paths, including the old
 * path of each rename, or null when there are too many to list (which fails
 * closed: it needs approval). `reviews` is read only when needed.
 */
export async function evaluate(input: {
  patterns: string[];
  files: string[] | null;
  headSha: string;
  author: string | null | undefined;
  reviews: () => Promise<Review[]>;
}): Promise<Verdict> {
  const guarded = input.files === null ? null : guardedFiles(input.patterns, input.files);
  const needsApproval = guarded === null || guarded.length > 0;
  const approved =
    needsApproval && approvedOnHead(await input.reviews(), input.headSha, input.author);
  return { guarded, needsApproval, approved, pass: !needsApproval || approved };
}

/** The commit status for a verdict; GitHub keeps 140 characters of a description. */
export function statusFor(verdict: Verdict): {
  state: "success" | "failure";
  description: string;
} {
  if (!verdict.needsApproval)
    return { state: "success", description: "Changes no model request files" };
  if (verdict.approved)
    return { state: "success", description: `${MAINTAINER} approved this head` };
  const what =
    verdict.guarded === null
      ? "Too many files to check"
      : `Changes ${verdict.guarded.length} model request file${verdict.guarded.length === 1 ? "" : "s"}`;
  return { state: "failure", description: `${what}: needs ${MAINTAINER}'s approval of this head` };
}

/** The one PR comment, rewritten in place as the PR changes. */
export function commentBody(
  verdict: Verdict,
  headSha: string,
  author: string | null | undefined,
): string {
  const head = `\`${headSha.slice(0, 10)}\``;
  const lines = [COMMENT_MARKER, "### Model request review", ""];
  if (!verdict.needsApproval) {
    lines.push(
      `This PR no longer changes what Opengeni sends to model providers (head ${head}), so it needs no model request review.`,
    );
    return lines.join("\n");
  }
  lines.push(
    verdict.approved
      ? `@${MAINTAINER} approved head ${head}. A new push needs a new approval.`
      : `This PR changes what Opengeni sends to model providers, so it lands only after @${MAINTAINER} approves its current head (${head}). The merge batcher holds it until then, and every new push needs a new approval.`,
    "",
  );
  if (verdict.guarded === null)
    lines.push(
      "It changes too many files for GitHub to list, so it is treated as changing guarded files.",
    );
  else {
    lines.push("Guarded files it changes:", "");
    for (const file of verdict.guarded) lines.push(`- \`${file}\``);
  }
  if (!verdict.approved) {
    lines.push(
      "",
      'Keep it a draft until its description says in plain words what changes on the wire and the possible quality, prompt-caching, behaviour or bug risks. Only the maintainer approves it, never an agent with his credentials (AGENTS.md, "Model request changes").',
    );
    if (isMaintainer(author))
      lines.push(
        "",
        `GitHub does not let an author approve their own PR. To approve this one, submit a review on its head commit whose first line is \`${SELF_APPROVAL_COMMAND}\`.`,
      );
  }
  return lines.join("\n");
}

// --- Command line: report the gate on one PR ---------------------------------

interface PullData {
  number: number;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  user: { login: string } | null;
  requested_reviewers: { login: string }[];
}

class GitHubApi {
  constructor(
    private readonly repository: string,
    private readonly token: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com/repos/${this.repository}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`GitHub ${response.status} for ${method} ${path}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async pages<T>(path: string, maxPages: number): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      items.push(...batch);
      if (batch.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  pull(number: number) {
    return this.request<PullData>("GET", `pulls/${number}`);
  }

  /** The open PR whose head is this branch of this repository, if any. */
  async pullForHead(owner: string, branch: string): Promise<PullData | null> {
    const head = encodeURIComponent(`${owner}:${branch}`);
    const pulls = await this.request<PullData[]>("GET", `pulls?state=open&head=${head}`);
    return pulls[0] ?? null;
  }

  /** Changed paths with the old path of each rename; null past GitHub's 3,000-file list. */
  async files(number: number): Promise<string[] | null> {
    const { items, complete } = await this.pages<{
      filename: string;
      previous_filename?: string;
    }>(`pulls/${number}/files`, 30);
    if (!complete) return null;
    return items.flatMap((f) =>
      f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
    );
  }

  async reviews(number: number): Promise<Review[]> {
    const { items } = await this.pages<{
      user: { login: string } | null;
      state: string;
      commit_id: string | null;
      body: string | null;
      submitted_at?: string | null;
    }>(`pulls/${number}/reviews`, 30);
    return items.map(toReview);
  }
}

/** A REST review as the gate reads it. */
export function toReview(review: {
  user: { login: string } | null;
  state: string;
  commit_id: string | null;
  body: string | null;
  submitted_at?: string | null;
}): Review {
  return {
    login: review.user?.login ?? null,
    state: review.state,
    commitId: review.commit_id,
    body: review.body,
    submittedAt: review.submitted_at ? Date.parse(review.submitted_at) : null,
  };
}

async function report(api: GitHubApi, pull: PullData, dryRun: boolean, targetUrl?: string) {
  const headSha = pull.head.sha;
  const author = pull.user?.login ?? null;
  const verdict = await evaluate({
    patterns: loadGuardedPatterns(),
    files: await api.files(pull.number),
    headSha,
    author,
    reviews: () => api.reviews(pull.number),
  });
  const status = statusFor(verdict);
  console.log(
    JSON.stringify({ pull: pull.number, head: headSha, author, ...verdict, status }, null, 2),
  );
  if (dryRun) return verdict;
  await api.request("POST", `statuses/${headSha}`, {
    state: status.state,
    context: STATUS_CONTEXT,
    description: status.description,
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
  const comments = await api.pages<{ id: number; body?: string; user: { login: string } | null }>(
    `issues/${pull.number}/comments`,
    30,
  );
  const existing = comments.items.find(
    (c) => c.body?.startsWith(COMMENT_MARKER) && c.user?.login === "github-actions[bot]",
  );
  // A PR that never touched guarded files gets no comment.
  if (verdict.needsApproval || existing) {
    const body = commentBody(verdict, headSha, author);
    if (!existing) await api.request("POST", `issues/${pull.number}/comments`, { body });
    else if (existing.body !== body)
      await api.request("PATCH", `issues/comments/${existing.id}`, { body });
  }
  // Re-request the review on every unapproved head; GitHub refuses a request
  // to the PR's own author, whose comment says how to approve instead.
  if (verdict.needsApproval && !verdict.approved && !isMaintainer(author) && pull.state === "open")
    await api.request("POST", `pulls/${pull.number}/requested_reviewers`, {
      reviewers: [MAINTAINER],
    });
  return verdict;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pull: { type: "string" },
      "head-owner": { type: "string" },
      "head-branch": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const repository = process.env.GITHUB_REPOSITORY ?? "Cloudgeni-ai/opengeni";
  const api = new GitHubApi(repository, token);
  let pull: PullData | null;
  if (values.pull) pull = await api.pull(Number(values.pull));
  else if (values["head-owner"] && values["head-branch"])
    pull = await api.pullForHead(values["head-owner"], values["head-branch"]);
  else throw new Error("Pass --pull <number>, or --head-owner and --head-branch");
  if (!pull) {
    console.log("No open pull request has that head; nothing to report.");
    process.exit(0);
  }
  const runUrl =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  const verdict = await report(api, pull, values["dry-run"] === true, runUrl);
  // A dry run exits 1 when the gate blocks, so it can be scripted.
  if (values["dry-run"] && !verdict.pass) process.exit(1);
}
