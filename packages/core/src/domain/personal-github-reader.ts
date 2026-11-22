import type { Settings } from "@opengeni/config";
import {
  PERSONAL_GITHUB_API_ORIGIN,
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  isPersonalGitHubConnection,
} from "@opengeni/contracts/personal-github";
import { buildConnectionTokenResolver, listConnectionsMetadata, type Database } from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { checkPersonalGitHubRepositoryAccess } from "./personal-github-repository-access";

/**
 * Reads GitHub's REST API as one person, with their own GitHub connection
 * (Your GitHub, docs/personal-github.md), for what Opengeni shows or watches
 * for them alone: a Linked panel's live status when the workspace's GitHub
 * App can't read the repository, and a "GitHub (your connection)" event
 * source. Only the repositories the person allowed Opengeni to use are read,
 * and only with GET. Null when they have no active connection, Your GitHub
 * isn't configured on this server, or the repository isn't one they allowed.
 */

export type PersonalGitHubRead = (path: string) => Promise<unknown>;

export type PersonalGitHubReaderDeps = {
  db: Database;
  settings: Settings;
  /** Replaces fetch, for tests and for the server's GitHub transport. */
  fetch?: typeof fetch | undefined;
};

/** GitHub answered a personal read with an error status. */
export class PersonalGitHubReadError extends Error {
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
    this.name = "PersonalGitHubReadError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/** The person's active Your GitHub connection in this workspace, newest first. */
export async function activePersonalGitHubConnection(
  deps: Pick<PersonalGitHubReaderDeps, "db" | "settings">,
  input: { workspaceId: string; subjectId: string },
) {
  if (!deps.settings.githubPersonalOauthEnabled) return null;
  const visible = await listConnectionsMetadata(deps.db, input.workspaceId, input.subjectId);
  return (
    visible
      .filter(
        (connection) =>
          connection.subjectId === input.subjectId &&
          connection.status === "active" &&
          isPersonalGitHubConnection(connection),
      )
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] ??
    null
  );
}

/**
 * A reader for `owner/name` as the person, or null (see above). Whether the
 * person allowed it is decided as for their other Your GitHub work
 * (`checkPersonalGitHubRepositoryAccess`: the connection's account, scope
 * and reconnect state, and their current repository choice), for reading.
 */
export async function personalGitHubReader(
  deps: PersonalGitHubReaderDeps,
  input: { accountId: string; workspaceId: string; subjectId: string; repository: string },
): Promise<PersonalGitHubRead | null> {
  const connection = await activePersonalGitHubConnection(deps, input);
  if (!connection) return null;
  const transport = deps.fetch ?? fetch;
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings, undefined, {
    ...(deps.fetch ? { refreshTransport: { fetchImpl: deps.fetch } } : {}),
  });
  const authorization = async (destinationUrl: string, forceRefresh: boolean) => {
    const credential = await resolver({
      workspaceId: connection.workspaceId,
      subjectId: input.subjectId,
      serverId: "github-personal-reader",
      toolName: "read",
      connectionRef: {
        connectionId: connection.id,
        providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectScope: "subject",
        scopes: ["repo"],
      },
      destinationUrl,
      credentialTarget: "http_api",
      forceRefresh,
    });
    if (credential.status !== "ok" || credential.connectionId !== connection.id) return null;
    return (
      Object.entries(credential.headers).find(
        ([name]) => name.toLowerCase() === "authorization",
      )?.[1] ?? null
    );
  };
  const get = async (url: URL): Promise<Response> => {
    if (url.origin !== PERSONAL_GITHUB_API_ORIGIN) throw new PersonalGitHubReadError(400);
    const send = async (forceRefresh: boolean) => {
      const header = await authorization(url.toString(), forceRefresh);
      if (!header) throw new PersonalGitHubReadError(401);
      return await transport(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          authorization: header,
          "user-agent": "Opengeni",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    };
    const response = await send(false);
    if (response.status !== 401) return response;
    await response.body?.cancel().catch(() => undefined);
    return await send(true);
  };
  const decision = await checkPersonalGitHubRepositoryAccess({
    db: deps.db,
    accountId: input.accountId,
    originWorkspaceId: connection.workspaceId,
    ownerSubjectId: input.subjectId,
    connectionId: connection.id,
    repository: { fullName: input.repository },
    access: "read",
    githubGet: get,
  }).catch(() => null);
  if (!decision?.allowed) return null;
  if (decision.mode === "all" && !deps.settings.githubPersonalAllRepositoriesEnabled) return null;
  return async (path) => {
    const response = await get(new URL(path, PERSONAL_GITHUB_API_ORIGIN));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PersonalGitHubReadError(response.status);
    }
    return await readResponseJsonBounded(response, RESPONSE_MAX_BYTES, "GitHub response");
  };
}
