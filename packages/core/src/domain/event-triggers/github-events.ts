import type { EventActorKind, EventTypeDescriptor } from "@opengeni/contracts";
import {
  oneLine,
  parseEventTime,
  readPath,
  truncateText,
  type NormalizedEventInput,
} from "./normalize";
import { WebhookBodyError, type WebhookAdapterReading } from "./webhook-adapters";
import { verifyHexBodyHmac } from "./webhook-signatures";

/**
 * GitHub App webhooks as automation events. A delivery's `X-GitHub-Event`
 * and the payload's `action` name the type (`pull_request.opened`, or `push`
 * when there is no action). The data is a compact, stable shape per event
 * family, not GitHub's payload: payloads repeat whole repository and user
 * objects, and an agent run only carries a few kilobytes of each event.
 */

/** Headers the reader uses; they are stored with the body so a delivery can be replayed. */
export const GITHUB_RETAINED_HEADERS = ["x-github-event", "x-github-delivery"] as const;

const BODY_MAX_CHARS = 1_500;
const COMMITS_MAX = 20;

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function login(value: unknown): string | null {
  return text(object(value)?.login);
}

function logins(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => login(entry) ?? []) : [];
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => text(object(entry)?.name) ?? []) : [];
}

function body(value: unknown): string | null {
  const found = text(value);
  return found === null ? null : truncateText(found, BODY_MAX_CHARS);
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.flatMap((entry) => int(object(entry)?.number) ?? []) : [];
}

/** Drop absent fields so the data stays small and conditions see only real values. */
function compact(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) =>
        entry !== null && entry !== undefined && !(Array.isArray(entry) && !entry.length),
    ),
  );
}

function repository(payload: Json): Json | null {
  const repo = object(payload.repository);
  if (!repo) return null;
  return compact({
    full_name: text(repo.full_name),
    name: text(repo.name),
    owner: login(repo.owner),
    private: bool(repo.private),
    default_branch: text(repo.default_branch),
    html_url: text(repo.html_url),
  });
}

function pullRequest(value: unknown): Json | null {
  const pr = object(value);
  if (!pr) return null;
  return compact({
    number: int(pr.number),
    title: text(pr.title),
    state: text(pr.state),
    draft: bool(pr.draft),
    merged: bool(pr.merged),
    user: login(pr.user),
    head: compact({ ref: text(object(pr.head)?.ref), sha: text(object(pr.head)?.sha) }),
    base: compact({ ref: text(object(pr.base)?.ref) }),
    labels: labelNames(pr.labels),
    requested_reviewers: logins(pr.requested_reviewers),
    additions: int(pr.additions),
    deletions: int(pr.deletions),
    changed_files: int(pr.changed_files),
    html_url: text(pr.html_url),
    body: body(pr.body),
  });
}

function issue(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    number: int(found.number),
    title: text(found.title),
    state: text(found.state),
    user: login(found.user),
    labels: labelNames(found.labels),
    assignees: logins(found.assignees),
    // An issue comment's issue can be a pull request.
    pull_request: found.pull_request !== undefined && found.pull_request !== null,
    html_url: text(found.html_url),
    body: body(found.body),
  });
}

function comment(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    id: int(found.id),
    user: login(found.user),
    path: text(found.path),
    line: int(found.line),
    html_url: text(found.html_url),
    body: body(found.body),
  });
}

function review(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    id: int(found.id),
    state: text(found.state)?.toLowerCase() ?? null,
    user: login(found.user),
    html_url: text(found.html_url),
    body: body(found.body),
  });
}

function checkRun(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    name: text(found.name),
    status: text(found.status),
    conclusion: text(found.conclusion),
    head_sha: text(found.head_sha),
    app: text(object(found.app)?.slug),
    pull_requests: numbers(found.pull_requests),
    html_url: text(found.html_url),
  });
}

function checkSuite(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    status: text(found.status),
    conclusion: text(found.conclusion),
    head_branch: text(found.head_branch),
    head_sha: text(found.head_sha),
    app: text(object(found.app)?.slug),
    pull_requests: numbers(found.pull_requests),
  });
}

function workflowRun(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    name: text(found.name),
    status: text(found.status),
    conclusion: text(found.conclusion),
    event: text(found.event),
    head_branch: text(found.head_branch),
    head_sha: text(found.head_sha),
    run_number: int(found.run_number),
    run_attempt: int(found.run_attempt),
    pull_requests: numbers(found.pull_requests),
    html_url: text(found.html_url),
  });
}

function release(value: unknown): Json | null {
  const found = object(value);
  if (!found) return null;
  return compact({
    tag_name: text(found.tag_name),
    name: text(found.name),
    draft: bool(found.draft),
    prerelease: bool(found.prerelease),
    html_url: text(found.html_url),
    body: body(found.body),
  });
}

function firstLine(value: unknown): string | null {
  const found = text(value);
  return found === null ? null : truncateText(found.split("\n")[0]!.trim(), 200);
}

function push(payload: Json): Json {
  const ref = text(payload.ref) ?? "";
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  return compact({
    ref,
    branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
    tag: ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : null,
    before: text(payload.before),
    after: text(payload.after),
    created: bool(payload.created),
    deleted: bool(payload.deleted),
    forced: bool(payload.forced),
    commit_count: commits.length,
    commits: commits.slice(0, COMMITS_MAX).flatMap((entry) => {
      const found = object(entry);
      return found
        ? [
            compact({
              id: text(found.id)?.slice(0, 12) ?? null,
              message: firstLine(found.message),
              author: text(object(found.author)?.name),
            }),
          ]
        : [];
    }),
    pusher: text(object(payload.pusher)?.name),
    compare: text(payload.compare),
  });
}

const PULL_REQUEST_VERBS: Record<string, string> = {
  opened: "opened",
  reopened: "reopened",
  edited: "edited",
  synchronize: "updated with new commits",
  ready_for_review: "ready for review",
  converted_to_draft: "turned into a draft",
  review_requested: "review requested",
  assigned: "assigned",
  labeled: "labeled",
  unlabeled: "unlabeled",
};

function verb(action: string | null, table: Record<string, string>): string {
  if (!action) return "changed";
  return table[action] ?? action.replaceAll("_", " ");
}

function reviewVerb(state: string | null): string {
  if (state === "approved") return "approved";
  if (state === "changes_requested") return "requested changes on";
  return "reviewed";
}

type Shaped = {
  subject: string | null;
  summary: string;
  url: string | null;
  data: Json;
  occurredAt?: Date | null;
};

/** The compact data, subject and one-line summary for one GitHub event. */
function shape(event: string, action: string | null, payload: Json): Shaped {
  const repo = repository(payload);
  const repoName = text(repo?.full_name) ?? "a repository";
  const actor = login(payload.sender);
  const base = { action, repository: repo, sender: actor };
  const ref = (number: unknown) => `${repoName}#${String(number ?? "?")}`;
  switch (event) {
    case "pull_request": {
      const pr = pullRequest(payload.pull_request);
      const merged = action === "closed" && pr?.merged === true;
      const label = text(object(payload.label)?.name);
      const requested = login(payload.requested_reviewer);
      const what = merged
        ? "merged"
        : action === "closed"
          ? "closed without merging"
          : verb(action, PULL_REQUEST_VERBS);
      const detail = label ? ` (${label})` : requested ? ` from ${requested}` : "";
      return {
        subject: ref(pr?.number),
        summary: `Pull request ${what}${detail}: ${ref(pr?.number)} ${text(pr?.title) ?? ""}`,
        url: text(pr?.html_url),
        data: compact({
          ...base,
          pull_request: pr,
          label,
          requested_reviewer: requested,
        }),
      };
    }
    case "pull_request_review": {
      const pr = pullRequest(payload.pull_request);
      const found = review(payload.review);
      return {
        subject: ref(pr?.number),
        summary: `${text(found?.user) ?? actor ?? "Someone"} ${reviewVerb(text(found?.state))} ${ref(pr?.number)} ${text(pr?.title) ?? ""}`,
        url: text(found?.html_url) ?? text(pr?.html_url),
        data: compact({ ...base, review: found, pull_request: pr }),
      };
    }
    case "pull_request_review_comment": {
      const pr = pullRequest(payload.pull_request);
      const found = comment(payload.comment);
      return {
        subject: ref(pr?.number),
        summary: `${text(found?.user) ?? actor ?? "Someone"} commented on the code in ${ref(pr?.number)} ${text(pr?.title) ?? ""}`,
        url: text(found?.html_url),
        data: compact({ ...base, comment: found, pull_request: pr }),
      };
    }
    case "issues": {
      const found = issue(payload.issue);
      const label = text(object(payload.label)?.name);
      const assignee = login(payload.assignee);
      const detail = label ? ` (${label})` : assignee ? ` to ${assignee}` : "";
      return {
        subject: ref(found?.number),
        summary: `Issue ${verb(action, {})}${detail}: ${ref(found?.number)} ${text(found?.title) ?? ""}`,
        url: text(found?.html_url),
        data: compact({ ...base, issue: found, label, assignee }),
      };
    }
    case "issue_comment": {
      const found = issue(payload.issue);
      const reply = comment(payload.comment);
      const kind = found?.pull_request === true ? "pull request" : "issue";
      return {
        subject: ref(found?.number),
        summary: `${text(reply?.user) ?? actor ?? "Someone"} commented on ${kind} ${ref(found?.number)} ${text(found?.title) ?? ""}`,
        url: text(reply?.html_url) ?? text(found?.html_url),
        data: compact({ ...base, comment: reply, issue: found }),
      };
    }
    case "push": {
      const pushed = push(payload);
      const where = text(pushed.branch) ?? text(pushed.tag) ?? text(pushed.ref) ?? "a ref";
      const count = int(pushed.commit_count) ?? 0;
      const what =
        pushed.deleted === true
          ? `${where} was deleted`
          : pushed.created === true && count === 0
            ? `${where} was created`
            : `${count} commit${count === 1 ? "" : "s"} pushed to ${where}${pushed.forced === true ? " (force push)" : ""}`;
      const head = object(payload.head_commit);
      return {
        subject: `${repoName}@${where}`,
        summary: `${what} in ${repoName}`,
        url: text(pushed.compare) ?? text(repo?.html_url),
        data: compact({ ...base, ...pushed }),
        occurredAt: parseEventTime(head?.timestamp),
      };
    }
    case "check_run": {
      const run = checkRun(payload.check_run);
      const outcome = text(run?.conclusion) ?? text(run?.status) ?? verb(action, {});
      return {
        subject: `${repoName}@${(text(run?.head_sha) ?? "").slice(0, 7)}`,
        summary: `Check ${text(run?.name) ?? "run"} ${outcome} in ${repoName}`,
        url: text(run?.html_url),
        data: compact({ ...base, check_run: run }),
      };
    }
    case "check_suite": {
      const suite = checkSuite(payload.check_suite);
      const outcome = text(suite?.conclusion) ?? text(suite?.status) ?? verb(action, {});
      return {
        subject: `${repoName}@${text(suite?.head_branch) ?? (text(suite?.head_sha) ?? "").slice(0, 7)}`,
        summary: `Checks ${outcome} on ${text(suite?.head_branch) ?? "a commit"} in ${repoName}`,
        url: text(repo?.html_url),
        data: compact({ ...base, check_suite: suite }),
      };
    }
    case "workflow_run": {
      const run = workflowRun(payload.workflow_run);
      const outcome =
        action === "completed" ? (text(run?.conclusion) ?? "finished") : verb(action, {});
      return {
        subject: `${repoName}@${text(run?.head_branch) ?? "?"}`,
        summary: `Workflow ${text(run?.name) ?? "run"} ${outcome} on ${text(run?.head_branch) ?? "a branch"} in ${repoName}`,
        url: text(run?.html_url),
        data: compact({ ...base, workflow_run: run }),
      };
    }
    case "release": {
      const found = release(payload.release);
      return {
        subject: `${repoName}@${text(found?.tag_name) ?? "?"}`,
        summary: `Release ${text(found?.name) ?? text(found?.tag_name) ?? ""} ${verb(action, {})} in ${repoName}`,
        url: text(found?.html_url),
        data: compact({ ...base, release: found }),
      };
    }
    default:
      return {
        subject: repo ? repoName : null,
        summary: `GitHub ${event.replaceAll("_", " ")}${action ? ` ${action.replaceAll("_", " ")}` : ""}${repo ? ` in ${repoName}` : ""}`,
        url: text(repo?.html_url),
        data: compact(base),
      };
  }
}

function actorKind(payload: Json, ownLogins: ReadonlySet<string>): EventActorKind {
  const sender = object(payload.sender);
  const name = text(sender?.login);
  if (!name) return "unknown";
  if (ownLogins.has(name.toLowerCase())) return "opengeni";
  return text(sender?.type) === "Bot" ? "bot" : "person";
}

/** GitHub events that are about the installation itself, not something in a repository. */
export const GITHUB_INSTALLATION_EVENTS = new Set([
  "installation",
  "installation_repositories",
  "installation_target",
  "github_app_authorization",
]);

/** Verify GitHub's `X-Hub-Signature-256` over the exact raw body. */
export function verifyGitHubWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
}): boolean {
  return verifyHexBodyHmac({
    secret: input.secret,
    signature: input.headers.get("x-hub-signature-256"),
    body: input.body,
  });
}

export function parseGitHubPayload(raw: Uint8Array): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new WebhookBodyError("The body is not JSON");
  }
  const found = object(parsed);
  if (!found) throw new WebhookBodyError("The body is not a JSON object");
  return found;
}

/**
 * One verified GitHub delivery as events. `ownLogins` are the logins of
 * Opengeni's own GitHub Apps (`slug[bot]`), whose events are marked as
 * Opengeni's so triggers skip them unless they opt in.
 */
export function readGitHubDelivery(input: {
  headers: Headers;
  body: Uint8Array;
  receivedAt: Date;
  ownLogins: ReadonlySet<string>;
}): WebhookAdapterReading {
  const event = input.headers.get("x-github-event")?.trim() ?? "";
  if (!/^[a-z_]{1,64}$/u.test(event)) {
    throw new WebhookBodyError("The delivery has no X-GitHub-Event header");
  }
  if (event === "ping") return { kind: "ignored", reason: "GitHub checked that the webhook works" };
  if (GITHUB_INSTALLATION_EVENTS.has(event)) {
    return { kind: "ignored", reason: "A change to the GitHub App's installation" };
  }
  const payload = parseGitHubPayload(input.body);
  const rawAction = text(payload.action);
  const action = rawAction && /^[a-z_]{1,64}$/u.test(rawAction) ? rawAction : null;
  const type = action ? `${event}.${action}` : event;
  const shaped = shape(event, action, payload);
  const sender = text(object(payload.sender)?.login);
  const normalized: NormalizedEventInput = {
    externalId: input.headers.get("x-github-delivery")?.trim() || null,
    type,
    occurredAt: shaped.occurredAt ?? input.receivedAt,
    subject: shaped.subject,
    summary: oneLine(shaped.summary, 300),
    url: shaped.url,
    actor: { kind: actorKind(payload, input.ownLogins), name: sender },
    data: shaped.data,
  };
  return { kind: "events", events: [normalized] };
}

/** The installation a delivery is for, if any. */
export function githubDeliveryInstallationId(payload: Json): number | null {
  const id = readPath(payload, "installation.id");
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The repository a delivery is about, if any. */
export function githubDeliveryRepositoryId(payload: Json): number | null {
  const id = readPath(payload, "repository.id");
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

type CatalogEntry = {
  type: string;
  description: string;
  fields?: Array<[string, string]>;
};

const REPOSITORY_FIELD: [string, string] = [
  "data.repository.full_name",
  "The repository, such as acme/api",
];
const SENDER_FIELD: [string, string] = ["data.sender", "The GitHub login that caused the event"];
const PULL_REQUEST_FIELDS: Array<[string, string]> = [
  REPOSITORY_FIELD,
  ["data.pull_request.number", "The pull request number"],
  ["data.pull_request.base.ref", "The branch it merges into, such as main"],
  ["data.pull_request.head.ref", "The branch with the changes"],
  ["data.pull_request.draft", "Whether it is a draft"],
  ["data.pull_request.labels", "Its label names"],
  ["data.pull_request.user", "Who opened it"],
  SENDER_FIELD,
];
const ISSUE_FIELDS: Array<[string, string]> = [
  REPOSITORY_FIELD,
  ["data.issue.number", "The issue number"],
  ["data.issue.labels", "Its label names"],
  ["data.issue.assignees", "Who it is assigned to"],
  ["data.issue.user", "Who opened it"],
  SENDER_FIELD,
];

const GITHUB_TYPES: CatalogEntry[] = [
  {
    type: "pull_request.opened",
    description: "A pull request was opened",
    fields: PULL_REQUEST_FIELDS,
  },
  {
    type: "pull_request.closed",
    description: "A pull request was merged or closed",
    fields: [...PULL_REQUEST_FIELDS, ["data.pull_request.merged", "true when it was merged"]],
  },
  {
    type: "pull_request.reopened",
    description: "A pull request was reopened",
    fields: PULL_REQUEST_FIELDS,
  },
  {
    type: "pull_request.synchronize",
    description: "New commits were pushed to a pull request",
    fields: PULL_REQUEST_FIELDS,
  },
  {
    type: "pull_request.ready_for_review",
    description: "A draft pull request was marked ready for review",
    fields: PULL_REQUEST_FIELDS,
  },
  {
    type: "pull_request.review_requested",
    description: "Someone was asked to review a pull request",
    fields: [...PULL_REQUEST_FIELDS, ["data.requested_reviewer", "Who was asked"]],
  },
  {
    type: "pull_request.labeled",
    description: "A label was added to a pull request",
    fields: [...PULL_REQUEST_FIELDS, ["data.label", "The label that was added"]],
  },
  {
    type: "pull_request_review.submitted",
    description: "A pull request review was submitted",
    fields: [
      REPOSITORY_FIELD,
      ["data.review.state", "approved, changes_requested or commented"],
      ["data.review.user", "The reviewer"],
      ["data.pull_request.number", "The pull request number"],
    ],
  },
  {
    type: "pull_request_review_comment.created",
    description: "Someone commented on a pull request's code",
    fields: [
      REPOSITORY_FIELD,
      ["data.comment.path", "The file the comment is on"],
      ["data.comment.user", "Who commented"],
    ],
  },
  { type: "issues.opened", description: "An issue was opened", fields: ISSUE_FIELDS },
  { type: "issues.closed", description: "An issue was closed", fields: ISSUE_FIELDS },
  { type: "issues.reopened", description: "An issue was reopened", fields: ISSUE_FIELDS },
  {
    type: "issues.assigned",
    description: "An issue was assigned",
    fields: [...ISSUE_FIELDS, ["data.assignee", "Who it was assigned to"]],
  },
  {
    type: "issues.labeled",
    description: "A label was added to an issue",
    fields: [...ISSUE_FIELDS, ["data.label", "The label that was added"]],
  },
  {
    type: "issue_comment.created",
    description: "Someone commented on an issue or pull request",
    fields: [
      REPOSITORY_FIELD,
      ["data.issue.number", "The issue or pull request number"],
      ["data.issue.pull_request", "true when the comment is on a pull request"],
      ["data.comment.user", "Who commented"],
      ["data.comment.body", "The comment text"],
    ],
  },
  {
    type: "push",
    description: "Commits were pushed to a branch or tag",
    fields: [
      REPOSITORY_FIELD,
      ["data.branch", "The branch, such as main"],
      ["data.forced", "true for a force push"],
      ["data.pusher", "Who pushed"],
    ],
  },
  {
    type: "check_run.completed",
    description: "A check finished",
    fields: [
      REPOSITORY_FIELD,
      ["data.check_run.name", "The check's name"],
      ["data.check_run.conclusion", "success, failure, cancelled, timed_out and so on"],
    ],
  },
  {
    type: "check_suite.completed",
    description: "All checks on a commit finished",
    fields: [
      REPOSITORY_FIELD,
      ["data.check_suite.conclusion", "success, failure and so on"],
      ["data.check_suite.head_branch", "The branch"],
    ],
  },
  {
    type: "workflow_run.completed",
    description: "A GitHub Actions workflow run finished",
    fields: [
      REPOSITORY_FIELD,
      ["data.workflow_run.name", "The workflow's name"],
      ["data.workflow_run.conclusion", "success, failure, cancelled and so on"],
      ["data.workflow_run.head_branch", "The branch it ran on"],
    ],
  },
  {
    type: "release.published",
    description: "A release was published",
    fields: [REPOSITORY_FIELD, ["data.release.tag_name", "The release tag"]],
  },
];

/** The GitHub App webhook event (`X-GitHub-Event`) behind an event type. */
export function githubAppEventFor(type: string): string {
  return type.split(".")[0]!;
}

/**
 * A GitHub source's event types: the known ones, then any other type it
 * delivered recently. With the App's subscribed events known, types the App
 * is not subscribed to are shown as unavailable with what to change.
 */
export function githubEventTypeCatalog(
  recent: ReadonlyArray<{ type: string; count: number }>,
  subscribedEvents: ReadonlySet<string> | null,
): EventTypeDescriptor[] {
  const descriptor = (entry: CatalogEntry): EventTypeDescriptor => {
    const appEvent = githubAppEventFor(entry.type);
    const available = subscribedEvents === null || subscribedEvents.has(appEvent);
    return {
      type: entry.type,
      description: entry.description,
      fields: (entry.fields ?? []).map(([field, description]) => ({ field, description })),
      argumentsSchema: null,
      available,
      unavailableReason: available
        ? null
        : `The GitHub App isn't subscribed to "${appEvent}" events. Turn them on in the App's Permissions & events settings.`,
    };
  };
  const known = GITHUB_TYPES.map(descriptor);
  const seen = new Set(known.map((entry) => entry.type));
  const observed = recent
    .filter((entry) => !seen.has(entry.type))
    .map((entry) =>
      descriptor({
        type: entry.type,
        description: `Received ${entry.count} time${entry.count === 1 ? "" : "s"} recently`,
      }),
    );
  return [...known, ...observed];
}

/** Logins of Opengeni's own GitHub Apps, whose events are Opengeni's. */
export function githubOwnLogins(slugs: ReadonlyArray<string | undefined>): Set<string> {
  return new Set(
    slugs.flatMap((slug) => (slug?.trim() ? [`${slug.trim().toLowerCase()}[bot]`] : [])),
  );
}
