import {
  createEventSource,
  listListeningEventTriggers,
  recordEventSourceFeedDelivery,
  type Database,
  type EventSourceRecord,
  type EventStatusReason,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import {
  activePersonalGitHubConnection,
  personalGitHubReader,
  PersonalGitHubReadError,
  type PersonalGitHubRead,
} from "../personal-github-reader";
import { sha256Hex } from "./delivery-intake";
import type {
  EventSourceFeedAdapter,
  EventSourceFeedReadContext,
  EventSourceFeedReadOutcome,
} from "./event-source-feeds";
import { githubReadEvent } from "./github-events";
import { eventMatchesTrigger } from "./matching";
import { McpEventSourceUnavailableError } from "./mcp-event-source-client";
import { boundEvent, type NormalizedEventInput } from "./normalize";
import { EventSourceBlockedError, eventStatusReason } from "./status-reason";

/**
 * "GitHub (your connection)": merges and releases read with one person's own
 * GitHub connection (Your GitHub), for a workspace without a GitHub app, such
 * as a self-hosted one. Nothing is pushed to Opengeni, so the feed reads only
 * what its automations name, every two minutes while one listens: the pull
 * requests a `pull_request.closed` trigger names (`data.repository.full_name`
 * and `data.pull_request.number` equal to a value) and the repositories a
 * `release.published` trigger names. A merge or release fires when it
 * happened after the trigger was created; each fires once (its delivery's
 * dedupe key), so the feed keeps no cursor. Only repositories the person
 * allowed Opengeni to use are read.
 */

export const GITHUB_PERSONAL_EVENT_SOURCE_NAME = "GitHub (your connection)";

const POLL_MS = 2 * 60_000;
const PULL_REQUESTS_MAX = 25;
const REPOSITORIES_MAX = 10;
const RELEASES_PER_READ = 10;
const RECONNECT = "Reconnect Your GitHub to keep its merges and releases coming";

/**
 * The caller's "GitHub (your connection)" source: one per person, so a
 * second create returns the first. It needs their Your GitHub connection.
 */
export async function createGitHubPersonalEventSource(input: {
  db: Database;
  settings: Parameters<typeof activePersonalGitHubConnection>[0]["settings"];
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  ownerSubjectId: string | null;
  name?: string | undefined;
}): Promise<EventSourceRecord> {
  if (!input.ownerSubjectId) {
    throw new HTTPException(422, {
      message: "A GitHub (your connection) source reads one person's GitHub. Create it as them.",
    });
  }
  const connection = await activePersonalGitHubConnection(input, {
    workspaceId: input.workspaceId,
    subjectId: input.ownerSubjectId,
  });
  if (!connection) {
    throw new HTTPException(422, {
      message: "Connect Your GitHub first; this source reads with that connection.",
    });
  }
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "github_personal",
    name: input.name ?? GITHUB_PERSONAL_EVENT_SOURCE_NAME,
    ownerSubjectId: input.ownerSubjectId,
    visibility: "private",
    connectionId: connection.id,
  });
  return source;
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function equalsValue(conditions: unknown[], field: string): string | number | null {
  for (const raw of conditions) {
    const condition = object(raw);
    if (condition?.field !== field || condition.op !== "equals") continue;
    const value = condition.value;
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return null;
}

/** `owner/name` as GitHub allows it, never a path such as `../x`. */
function isRepositoryName(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => /^[\w.-]{1,100}$/u.test(part) && !/^\.+$/u.test(part))
  );
}

/** What the listening triggers ask about, each with the earliest trigger's creation. */
export function githubPersonalTargets(
  triggers: ReadonlyArray<{ eventTypes: string[]; conditions: unknown[]; createdAt: Date }>,
): {
  pullRequests: Map<string, { repository: string; number: number; since: Date }>;
  releases: Map<string, { repository: string; since: Date }>;
} {
  const pullRequests = new Map<string, { repository: string; number: number; since: Date }>();
  const releases = new Map<string, { repository: string; since: Date }>();
  for (const trigger of triggers) {
    const repository = equalsValue(trigger.conditions, "data.repository.full_name");
    if (typeof repository !== "string" || !isRepositoryName(repository)) continue;
    if (trigger.eventTypes.includes("pull_request.closed")) {
      const number = Number(equalsValue(trigger.conditions, "data.pull_request.number"));
      if (Number.isSafeInteger(number) && number > 0) {
        const key = `${repository.toLowerCase()}#${number}`;
        const known = pullRequests.get(key);
        if (!known || trigger.createdAt < known.since) {
          pullRequests.set(key, { repository, number, since: trigger.createdAt });
        }
      }
    }
    if (trigger.eventTypes.includes("release.published")) {
      const key = repository.toLowerCase();
      const known = releases.get(key);
      if (!known || trigger.createdAt < known.since) {
        releases.set(key, { repository, since: trigger.createdAt });
      }
    }
  }
  return { pullRequests, releases };
}

function time(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * GitHub's times have whole seconds and a wake reads the pull request just
 * before its trigger is saved: a merge that close to the trigger still counts.
 * The dedupe key keeps it from firing twice.
 */
const SINCE_GRACE_MS = 2 * 60_000;

function happenedBefore(at: Date, since: Date): boolean {
  return at.getTime() < since.getTime() - SINCE_GRACE_MS;
}

/** The newest triggers first, so old ones that will never fire don't crowd out new ones. */
function newestFirst<T extends { since: Date }>(targets: Iterable<T>): T[] {
  return [...targets].sort((left, right) => right.since.getTime() - left.since.getTime());
}

/** `owner/name` as GitHub spells it, from a release's page address. */
function releaseRepository(release: Json, fallback: string): string {
  const url = typeof release.html_url === "string" ? release.html_url : "";
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\//u.exec(url);
  return match?.[1] ?? fallback;
}

/**
 * The merges and releases the targets name that happened since their
 * triggers were created, read with `readerFor` (null for a repository the
 * person doesn't allow). Each comes with its dedupe key; a target whose read
 * failed is in `failures` and doesn't stop the others.
 */
export async function githubPersonalReadEvents(
  targets: ReturnType<typeof githubPersonalTargets>,
  readerFor: (repository: string) => Promise<PersonalGitHubRead | null>,
): Promise<{
  found: Array<{ key: string; event: NormalizedEventInput }>;
  failures: unknown[];
  reads: number;
}> {
  const found: Array<{ key: string; event: NormalizedEventInput }> = [];
  // One repository failing (SSO, a revoked grant, GitHub erroring) doesn't
  // hold up the others; what was found is still recorded.
  const failures: unknown[] = [];
  let reads = 0;
  const attempt = async (work: () => Promise<void>) => {
    reads += 1;
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const target of newestFirst(targets.pullRequests.values()).slice(0, PULL_REQUESTS_MAX)) {
    await attempt(async () => {
      const read = await readerFor(target.repository);
      // A repository the person no longer allows Opengeni to use isn't read.
      if (!read) return;
      const pr = object(
        await unlessGone(() => read(`/repos/${target.repository}/pulls/${target.number}`)),
      );
      const closedAt = time(pr?.closed_at);
      if (!pr || pr.state !== "closed" || !closedAt || happenedBefore(closedAt, target.since)) {
        return;
      }
      const repository = object(object(pr.base)?.repo);
      const sender = pr.merged === true ? (pr.merged_by ?? pr.user) : pr.user;
      const key = `pr:${String(repository?.full_name ?? target.repository).toLowerCase()}#${target.number}:${closedAt.toISOString()}`;
      found.push({
        key,
        event: githubReadEvent({
          event: "pull_request",
          action: "closed",
          payload: { action: "closed", repository, pull_request: pr, sender },
          externalId: key,
          occurredAt: closedAt,
        }),
      });
    });
  }
  for (const target of newestFirst(targets.releases.values()).slice(0, REPOSITORIES_MAX)) {
    await attempt(async () => {
      const read = await readerFor(target.repository);
      if (!read) return;
      const listed = await unlessGone(() =>
        read(`/repos/${target.repository}/releases?per_page=${RELEASES_PER_READ}`),
      );
      for (const release of (Array.isArray(listed) ? listed : []).map(object)) {
        const publishedAt = time(release?.published_at);
        if (
          !release ||
          release.draft === true ||
          !publishedAt ||
          happenedBefore(publishedAt, target.since)
        ) {
          continue;
        }
        const fullName = releaseRepository(release, target.repository);
        const key = `release:${fullName.toLowerCase()}:${String(release.id)}`;
        found.push({
          key,
          event: githubReadEvent({
            event: "release",
            action: "published",
            payload: {
              action: "published",
              repository: {
                full_name: fullName,
                name: fullName.split("/")[1],
                owner: { login: fullName.split("/")[0] },
                html_url: `https://github.com/${fullName}`,
              },
              release,
              sender: release.author,
            },
            externalId: key,
            occurredAt: publishedAt,
          }),
        });
      }
    });
  }
  return { found, failures, reads };
}

async function readGitHubPersonalFeed(
  context: EventSourceFeedReadContext,
): Promise<EventSourceFeedReadOutcome> {
  const { deps, source, now } = context;
  const owner = source.ownerSubjectId;
  if (!owner) throw new McpEventSourceUnavailableError("unavailable", "This source has no owner");
  const later = new Date(now.getTime() + POLL_MS);
  const connection = await activePersonalGitHubConnection(deps, {
    workspaceId: source.workspaceId,
    subjectId: owner,
  });
  if (!connection) throw new EventSourceBlockedError(eventStatusReason("reconnect", RECONNECT));
  const targets = githubPersonalTargets(
    await listListeningEventTriggers(deps.db, source.workspaceId, source.id),
  );
  const readers = new Map<string, Awaited<ReturnType<typeof personalGitHubReader>>>();
  const readerFor = async (repository: string) => {
    const key = repository.toLowerCase();
    if (!readers.has(key)) {
      readers.set(
        key,
        await personalGitHubReader(
          { db: deps.db, settings: deps.settings, fetch: deps.githubFetch },
          {
            accountId: source.accountId,
            workspaceId: source.workspaceId,
            subjectId: owner,
            repository,
          },
        ),
      );
    }
    return readers.get(key) ?? null;
  };
  const { found, failures, reads } = await githubPersonalReadEvents(targets, readerFor);
  // One delivery per merge or release, so each fires once however often it is read.
  for (const { key, event } of found) {
    const body = new TextEncoder().encode(JSON.stringify({ type: event.type, data: event.data }));
    const recorded = await recordEventSourceFeedDelivery(deps.db, {
      workspaceId: source.workspaceId,
      sourceId: source.id,
      cursor: "{}",
      delivery: {
        status: "accepted",
        reason: null,
        dedupeKey: `github_personal:${sha256Hex(new TextEncoder().encode(key))}`,
        body,
        bodyBytes: body.byteLength,
        bodySha256: sha256Hex(body),
        headers: {},
        events: [boundEvent(event, now)],
        match: eventMatchesTrigger,
      },
    });
    if (!recorded) throw new Error("The source was removed while its events were read");
  }
  // A sign-in that stopped working blocks the source; so does every read failing.
  const signIn = failures.find(
    (error) => error instanceof PersonalGitHubReadError && error.status === 401,
  );
  if (signIn || (failures.length > 0 && failures.length === reads)) throw signIn ?? failures[0];
  for (const error of failures) {
    deps.observability?.warn("A GitHub (your connection) read failed; it will retry", {
      sourceId: source.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { cursor: "{}", nextActionAt: later };
}

function blockedReason(error: unknown): EventStatusReason | null {
  // 403 is also GitHub's rate limit, which passes; it blocks only after an hour.
  if (error instanceof PersonalGitHubReadError && error.status === 401) {
    return eventStatusReason("reconnect", RECONNECT);
  }
  return null;
}

/** A pull request or repository that is gone, or no longer visible to the person, is skipped. */
async function unlessGone<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PersonalGitHubReadError && error.status === 404) return null;
    throw error;
  }
}

export const githubPersonalFeed: EventSourceFeedAdapter = {
  appName: "GitHub",
  read: readGitHubPersonalFeed,
  blockedReason,
};
