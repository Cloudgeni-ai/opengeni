import { personalGitHubSetupPath } from "@opengeni/contracts/personal-github";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { hasPermission } from "@opengeni/core";

/**
 * The person's own GitHub identity ("Your GitHub") as the agent sees it, next
 * to the workspace GitHub App fields of `github_connect_link`. Status only:
 * it never carries a token, and its links are plain console pages that the
 * person still confirms on GitHub.
 */
export type PersonalGitHubIdentityStatus = {
  enabled: boolean;
  /** Null when this person's connection cannot be read here (see `note`). */
  connected: boolean | null;
  status: "disabled" | "not_connected" | "connected" | "needs_reconnect" | "unknown";
  login: string | null;
  /** Repositories the person allowed Opengeni to use as them. */
  repositoryCount: number | null;
  /** Opens the console on the "Your GitHub" Connect action. */
  connectUrl: string | null;
  /** Opens the console on the repository chooser for a connected identity. */
  manageUrl: string | null;
  note?: string;
};

export type PersonalGitHubConnectionSummary = {
  id: string;
  status: string;
  workspaceId: string;
  metadata: Record<string, unknown>;
};

export type PersonalGitHubPerson = {
  subjectId: string;
  permissions: readonly string[];
  permissionMode?: AccessGrant["permissionMode"];
};

const NON_PERSON_PRINCIPAL_KINDS: ReadonlySet<string> = new Set([
  "service",
  "api_key",
  "configured_key",
]);

/**
 * The human this agent acts for, as personal GitHub sees them: the person who
 * started the exact live attempt (never the session creator), with the
 * permissions frozen when they sent the message, or the caller itself for a
 * direct human grant. Null when no person started this work.
 */
export async function resolvePersonalGitHubPerson(input: {
  grant: Pick<AccessGrant, "subjectId" | "permissions" | "permissionMode" | "principalKind">;
  isAgentAttempt: boolean;
  /** The initiating human of the live attempt; throws when the attempt is stale. */
  loadInitiator: () => Promise<string | null>;
  /** That person's frozen send-time (or current) workspace access. */
  loadSenderGrant: () => Promise<{
    permissions: readonly string[];
    permissionMode?: AccessGrant["permissionMode"] | undefined;
  } | null>;
}): Promise<PersonalGitHubPerson | null> {
  const { grant } = input;
  if (!input.isAgentAttempt) {
    if (grant.principalKind && NON_PERSON_PRINCIPAL_KINDS.has(grant.principalKind)) return null;
    return {
      subjectId: grant.subjectId,
      permissions: grant.permissions,
      ...(grant.permissionMode ? { permissionMode: grant.permissionMode } : {}),
    };
  }
  const initiator = await input.loadInitiator();
  if (!initiator) return null;
  const access = await input.loadSenderGrant();
  return access
    ? {
        subjectId: initiator,
        permissions: access.permissions,
        ...(access.permissionMode ? { permissionMode: access.permissionMode } : {}),
      }
    : null;
}

export async function personalGitHubIdentityStatus(input: {
  enabled: boolean;
  workspaceId: string;
  /** Browser origin for console links; empty keeps them relative. */
  baseUrl: string;
  /** The human this agent acts for; null when no person started this work. */
  person: PersonalGitHubPerson | null;
  loadConnection: (subjectId: string) => Promise<PersonalGitHubConnectionSummary | null>;
  loadRepositoryCount: (
    subjectId: string,
    connection: PersonalGitHubConnectionSummary,
  ) => Promise<number | null>;
}): Promise<PersonalGitHubIdentityStatus> {
  const empty = {
    login: null,
    repositoryCount: null,
    connectUrl: null,
    manageUrl: null,
  };
  if (!input.enabled) {
    return {
      enabled: false,
      connected: false,
      status: "disabled",
      ...empty,
      note: "Personal GitHub sign-in is not enabled on this deployment; only the Opengeni app is available.",
    };
  }
  const person = input.person;
  if (!person) {
    return {
      enabled: true,
      connected: null,
      status: "unknown",
      ...empty,
      note: "No person started this work, so there is no personal GitHub identity to use.",
    };
  }
  const can = (permission: Permission) =>
    hasPermission(person.permissions as Permission[], permission, person.permissionMode);
  if (!can("connections:read")) {
    return {
      enabled: true,
      connected: null,
      status: "unknown",
      ...empty,
      note: "This person's access doesn't include reading their connections here.",
    };
  }
  const link = `${input.baseUrl.replace(/\/+$/u, "")}${personalGitHubSetupPath(input.workspaceId)}`;
  const canConnect = can("connections:write");
  const connection = await input.loadConnection(person.subjectId);
  if (!connection || connection.status === "revoked") {
    return {
      enabled: true,
      connected: false,
      status: "not_connected",
      ...empty,
      connectUrl: canConnect ? link : null,
      ...(canConnect
        ? {}
        : { note: "This person's access doesn't allow connecting accounts in this workspace." }),
    };
  }
  const login =
    typeof connection.metadata.githubLogin === "string" && connection.metadata.githubLogin
      ? connection.metadata.githubLogin
      : null;
  if (connection.status !== "active") {
    return {
      enabled: true,
      connected: false,
      status: "needs_reconnect",
      ...empty,
      login,
      connectUrl: canConnect ? link : null,
      note: "The person must reconnect their GitHub account before Opengeni can act as them.",
    };
  }
  const repositoryCount = await input
    .loadRepositoryCount(person.subjectId, connection)
    .catch(() => null);
  return {
    enabled: true,
    connected: true,
    status: "connected",
    login,
    repositoryCount,
    connectUrl: null,
    manageUrl: canConnect ? link : null,
    ...(repositoryCount === 0
      ? { note: "No repositories are allowed yet; the person chooses them with manageUrl." }
      : {}),
  };
}

/** Agent guidance shared by the GitHub status tool and its setup cards. */
export const GITHUB_IDENTITIES_GUIDANCE =
  "Two GitHub identities exist. Your GitHub (personal): the person's own account; commits, branches, pull requests and reviews appear under their name, only in chats they start, on repositories they choose. Opengeni app: work appears as the Opengeni bot, shared with the workspace, installed per organization or account. 'Connect my GitHub', 'use my account' or 'do it as me' means personal; 'install the GitHub app' or 'give Opengeni access to the org/repos' means the app.";

/** Console origin for the person's links: the web console, never the API's own origin. */
export function personalGitHubConsoleBaseUrl(input: {
  webBaseUrl?: string | null | undefined;
  publicOrigin?: string | null | undefined;
  requestOrigin?: string | null | undefined;
}): string {
  const web = input.webBaseUrl?.trim().replace(/\/+$/u, "");
  return web || input.publicOrigin || input.requestOrigin || "";
}

/** Agent guidance for the console link to the workspace's GitHub settings. */
export const GITHUB_APP_SETTINGS_GUIDANCE =
  "settingsUrl opens this workspace's GitHub settings, where a workspace admin chooses Install on another account; give it when installUrl is null.";

/** Console link to the workspace's GitHub settings sheet; null without a console origin. */
export function githubSettingsUrl(baseUrl: string, workspaceId: string): string | null {
  const base = baseUrl.replace(/\/+$/u, "");
  if (!base) return null;
  return `${base}/workspaces/${encodeURIComponent(workspaceId)}/plugins?open=${encodeURIComponent(
    "integration:github",
  )}`;
}

export type PersonalGitHubSetupProjection =
  | { status: "ready"; action: null; detail: string }
  | { status: "authorization_required"; action: "connect"; detail: string }
  | { status: "unavailable"; action: null; detail: string };

/** "Your GitHub" setup-card readiness from the person's status (null when unreadable). */
export function personalGitHubSetupProjection(
  personal: PersonalGitHubIdentityStatus | null,
): PersonalGitHubSetupProjection {
  if (!personal) {
    return {
      status: "unavailable",
      action: null,
      detail: "Your GitHub status could not be read right now.",
    };
  }
  switch (personal.status) {
    case "connected": {
      const as = personal.login ? ` as @${personal.login}` : "";
      const count =
        personal.repositoryCount === null
          ? ""
          : ` with ${personal.repositoryCount} allowed ${personal.repositoryCount === 1 ? "repository" : "repositories"}`;
      return { status: "ready", action: null, detail: `Your GitHub is connected${as}${count}.` };
    }
    case "not_connected":
    case "needs_reconnect":
      return personal.connectUrl
        ? {
            status: "authorization_required",
            action: "connect",
            detail:
              personal.status === "needs_reconnect"
                ? "The person must reconnect their GitHub account from the card."
                : "The person connects their own GitHub account from the card, then chooses repositories.",
          }
        : {
            status: "unavailable",
            action: null,
            detail: personal.note ?? "This person can't connect a GitHub account here.",
          };
    default:
      return {
        status: "unavailable",
        action: null,
        detail: personal.note ?? "Your GitHub isn't available here.",
      };
  }
}
