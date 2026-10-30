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
