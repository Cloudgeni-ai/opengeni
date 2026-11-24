/**
 * A run a GitHub pull request event started, refused or failed before its
 * chat started (docs/scheduled-admission-diagnostics.md, "Refused pull
 * request runs"), says so on that pull request: one short comment through
 * the workspace's GitHub App, in plain words, so the people waiting on a
 * review aren't left guessing. Its owner is told in Opengeni as for any
 * refused run.
 *
 * The pull request is trusted only as the run's repositories are
 * (scheduled-event-repositories.ts): the allowlist must offer its repository
 * id through one of the workspace's installations, and GitHub, asked
 * through that installation, must resolve the event's `owner/name` to that
 * id. Test events (no sender) never comment. At most one comment per pull
 * request and cause within {@link REFUSED_RUN_COMMENT_WINDOW_MS}, found by a
 * hidden marker on the App's own comments. Best effort: a failure is logged
 * and never changes the run.
 */
import type { Settings } from "@opengeni/config";
import type { InboundEvent, ScheduledTask, ScheduledTaskRun } from "@opengeni/contracts";
import {
  eventOccurrenceIdFromProducerKey,
  getEventOccurrenceForRun,
  getScheduledTask,
  getScheduledTaskRunByProducerKey,
  listAllowedGitHubRepositoryIdsForWorkspace,
  listGitHubInstallationIdsForWorkspace,
  type Database,
} from "@opengeni/db";
import {
  createGitHubAppInstallationTokenWithSigningSettings,
  type GitHubAppInstallationRepositoryLookup,
} from "@opengeni/github";

/** One comment per pull request and cause in this window. */
export const REFUSED_RUN_COMMENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** At most this many pull requests commented on per run. */
export const REFUSED_RUN_COMMENT_LIMIT = 3;
const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 10_000;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export type RefusedPullRequest = {
  repositoryId: number;
  owner: string;
  name: string;
  number: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The pull request one GitHub event is about, or null. */
export function githubEventPullRequest(
  event: Pick<InboundEvent, "sourceKind" | "type" | "actor" | "data">,
): RefusedPullRequest | null {
  if (event.sourceKind !== "github") return null;
  // A test event is anyone's data, sent with no GitHub sender.
  if (!event.actor.name) return null;
  const kind = event.type.split(".")[0];
  let number: number | null = null;
  if (
    kind === "pull_request" ||
    kind === "pull_request_review" ||
    kind === "pull_request_review_comment" ||
    kind === "pull_request_review_thread"
  ) {
    number = positive(record(event.data.pull_request)?.number);
  } else if (kind === "issue_comment") {
    const issue = record(event.data.issue);
    if (issue?.pull_request === true) number = positive(issue.number);
  }
  if (number === null) return null;
  const repository = record(event.data.repository);
  const repositoryId = positive(repository?.id);
  const fullName = repository?.full_name;
  if (repositoryId === null || typeof fullName !== "string" || !FULL_NAME.test(fullName)) {
    return null;
  }
  const [owner = "", name = ""] = fullName.split("/");
  if ([owner, name].some((part) => part === "." || part === "..")) return null;
  return { repositoryId, owner, name, number };
}

/** The distinct pull requests a run's events are about, at most the limit. */
export function refusedRunPullRequests(
  events: readonly Pick<InboundEvent, "sourceKind" | "type" | "actor" | "data">[],
): RefusedPullRequest[] {
  const found = new Map<string, RefusedPullRequest>();
  for (const event of events) {
    const pullRequest = githubEventPullRequest(event);
    if (!pullRequest) continue;
    const key = `${pullRequest.repositoryId}#${pullRequest.number}`;
    if (!found.has(key)) found.set(key, pullRequest);
    if (found.size >= REFUSED_RUN_COMMENT_LIMIT) break;
  }
  return [...found.values()];
}

/** Why each refusal stops a run, as the comment says it. */
const CAUSE_TEXT: Record<string, string> = {
  scheduled_run_authority_proof_rejected:
    "the access its owner saved it with has changed, so its owner needs to open it in Opengeni and save it again",
  scheduled_causal_membership_changed:
    "the access its owner saved it with has changed, so its owner needs to open it in Opengeni and save it again",
  scheduled_authority_unavailable:
    "the access its owner saved it with has changed, so its owner needs to open it in Opengeni and save it again",
  scheduled_authority_exhausted:
    "the access its owner saved it with has run out, so its owner needs to open it in Opengeni and save it again",
  scheduled_agent_unavailable: "its agent was deleted or is no longer shared",
  scheduled_model_unavailable: "its model is no longer available",
  scheduled_session_spawn_denied: "the workspace doesn't allow it to start chats right now",
  scheduled_workspace_paused: "agent activity in the workspace is paused",
  connection_account_unavailable: "a connected account it needs can no longer be used",
  insufficient_credits: "the workspace is out of credits",
  allowance_exhausted: "the workspace's usage allowance is used up",
  monthly_model_cost_limit: "the workspace reached its monthly model cost limit",
  monthly_agent_run_limit: "the workspace reached its monthly run limit",
  session_usage_limit: "it reached its usage limit",
  machine_target_unavailable: "the machine it runs on is no longer available",
  machine_enrollment_inactive: "the machine it runs on is disconnected",
  rig_version_unavailable: "its setup has no usable version",
};

/**
 * Why a run that never started its chat was stopped, or null when it isn't
 * a refusal worth telling the pull request about.
 */
export function refusedRunCause(
  run: Pick<
    ScheduledTaskRun,
    "status" | "sessionId" | "error" | "admissionRefusal" | "admissionDiagnostic"
  >,
): string | null {
  if ((run.status !== "failed" && run.status !== "skipped") || run.sessionId !== null) return null;
  if (run.admissionDiagnostic) return "connection_account_unavailable";
  if (run.admissionRefusal) return run.admissionRefusal.reason;
  return run.error && CAUSE_TEXT[run.error] ? run.error : null;
}

/** The hidden marker that finds an earlier comment for the same cause. */
export function refusedRunCommentMarker(cause: string): string {
  return `<!-- opengeni:automation-refused:${cause.replace(/[^a-z0-9_]/gu, "")} -->`;
}

/** The comment: what couldn't run, why, and that its owner was told. */
export function refusedRunCommentBody(input: { cause: string; automation: string | null }): string {
  const what = input.automation ? `“${input.automation}”` : "an automation";
  const why = CAUSE_TEXT[input.cause] ?? "it was refused before it started";
  return `Opengeni couldn't run ${what} on this pull request: ${why}. Its owner has been told in Opengeni.\n\n${refusedRunCommentMarker(input.cause)}`;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type RefusedRunCommentDependencies = {
  db: Database;
  settings: Pick<Settings, "githubAppId" | "githubAppPrivateKey" | "githubAppSlug">;
  lookup: GitHubAppInstallationRepositoryLookup | null;
  fetch?: Fetch;
  now?: () => Date;
  /** Mints a token for one repository; the real App by default. */
  mintToken?: (input: { installationId: number; repositoryId: number }) => Promise<string>;
  warn?: (message: string, fields: Record<string, string | number>) => void;
};

function headers(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "opengeni",
  };
}

/**
 * Comment on the pull requests a refused event run was about. Returns how
 * many comments it posted. Never throws.
 */
export async function commentOnRefusedPullRequests(
  deps: RefusedRunCommentDependencies,
  input: { workspaceId: string; taskId: string; producerKey: string },
): Promise<number> {
  const warn =
    deps.warn ??
    ((message: string, fields: Record<string, string | number>) => console.warn(message, fields));
  try {
    return await commentOnRefusedPullRequestsUnsafe(deps, input, warn);
  } catch (error) {
    warn("Commenting on a refused run's pull request failed", {
      taskId: input.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function commentOnRefusedPullRequestsUnsafe(
  deps: RefusedRunCommentDependencies,
  input: { workspaceId: string; taskId: string; producerKey: string },
  warn: (message: string, fields: Record<string, string | number>) => void,
): Promise<number> {
  const slug = deps.settings.githubAppSlug?.trim().toLowerCase();
  if (!deps.lookup || !slug) return 0;
  const occurrenceId = eventOccurrenceIdFromProducerKey(input.producerKey);
  if (!occurrenceId) return 0;
  const run = await getScheduledTaskRunByProducerKey(deps.db, {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    triggerType: "event",
    producerKey: input.producerKey,
  });
  const cause = run ? refusedRunCause(run) : null;
  if (!cause) return 0;
  const occurrence = await getEventOccurrenceForRun(deps.db, input.workspaceId, occurrenceId);
  if (!occurrence || occurrence.taskId !== input.taskId) return 0;
  const pullRequests = refusedRunPullRequests(occurrence.events);
  if (pullRequests.length === 0) return 0;
  const task: ScheduledTask | null = await getScheduledTask(
    deps.db,
    input.workspaceId,
    input.taskId,
  );
  // An Only me automation's name stays out of the pull request.
  const automation =
    task && task.visibility === "workspace" && task.name.trim() ? task.name.trim() : null;

  const installationFor = new Map<number, number>();
  for (const installationId of await listGitHubInstallationIdsForWorkspace(
    deps.db,
    input.workspaceId,
  )) {
    const pending = pullRequests
      .map((pullRequest) => pullRequest.repositoryId)
      .filter((id) => !installationFor.has(id));
    if (pending.length === 0) break;
    for (const id of await listAllowedGitHubRepositoryIdsForWorkspace(
      deps.db,
      input.workspaceId,
      installationId,
      pending,
    )) {
      installationFor.set(id, installationId);
    }
  }

  return await postRefusedRunComments(
    deps,
    {
      taskId: input.taskId,
      cause,
      automation,
      pullRequests,
      installationFor,
    },
    warn,
  );
}

/**
 * Post the comment on each pull request whose repository the allowlist
 * offers (`installationFor`) and GitHub confirms, unless the App already
 * said so for this cause within the window.
 */
export async function postRefusedRunComments(
  deps: Pick<RefusedRunCommentDependencies, "settings" | "lookup" | "fetch" | "now" | "mintToken">,
  input: {
    taskId: string;
    cause: string;
    automation: string | null;
    pullRequests: readonly RefusedPullRequest[];
    installationFor: ReadonlyMap<number, number>;
  },
  warn: (message: string, fields: Record<string, string | number>) => void,
): Promise<number> {
  const slug = deps.settings.githubAppSlug?.trim().toLowerCase();
  if (!deps.lookup || !slug) return 0;
  const { cause, automation, pullRequests, installationFor } = input;
  const fetcher: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now?.() ?? new Date();
  const mint =
    deps.mintToken ??
    (async ({ installationId, repositoryId }: { installationId: number; repositoryId: number }) =>
      (
        await createGitHubAppInstallationTokenWithSigningSettings(deps.settings, {
          installationId,
          repositoryIds: [repositoryId],
          permissions: { pull_requests: "write" },
          timeoutMs: GITHUB_TIMEOUT_MS,
        })
      ).token);
  const marker = refusedRunCommentMarker(cause);
  const ownLogin = `${slug}[bot]`;
  let posted = 0;
  for (const pullRequest of pullRequests) {
    const installationId = installationFor.get(pullRequest.repositoryId);
    if (installationId === undefined) continue;
    const found = await deps.lookup({
      installationId,
      owner: pullRequest.owner,
      name: pullRequest.name,
    });
    // The event's name must be the allowlisted repository's, as GitHub says now.
    if (!found || found.id !== pullRequest.repositoryId) continue;
    const token = await mint({
      installationId,
      repositoryId: pullRequest.repositoryId,
    });
    const path = `${GITHUB_API}/repos/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(
      pullRequest.name,
    )}/issues/${pullRequest.number}/comments`;
    const since = new Date(now.getTime() - REFUSED_RUN_COMMENT_WINDOW_MS).toISOString();
    const listed = await fetcher(`${path}?since=${encodeURIComponent(since)}&per_page=100`, {
      headers: headers(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!listed.ok) {
      warn("Reading a refused run's pull request comments failed", {
        taskId: input.taskId,
        status: listed.status,
      });
      continue;
    }
    const comments = (await listed.json()) as unknown;
    const told =
      Array.isArray(comments) &&
      comments.some((comment) => {
        const entry = record(comment);
        const login = record(entry?.user)?.login;
        return (
          typeof login === "string" &&
          login.toLowerCase() === ownLogin &&
          typeof entry?.body === "string" &&
          entry.body.includes(marker)
        );
      });
    if (told) continue;
    const created = await fetcher(path, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({
        body: refusedRunCommentBody({ cause, automation }),
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!created.ok) {
      warn("Commenting on a refused run's pull request failed", {
        taskId: input.taskId,
        status: created.status,
      });
      continue;
    }
    posted += 1;
  }
  return posted;
}
