import type { OpenGeniClient } from "./client";

export type TeamsBotStatus = {
  enabled: boolean;
  configured: boolean;
  /**
   * The name of this deployment's Teams app, as people see it in Teams.
   * Absent from servers that predate it.
   */
  appName?: string;
  setupAvailable: boolean;
  installation: { tenantId: string; workspaceId: string; active: boolean } | null;
  linked: boolean;
  delivery?: { pending: number; unknown: number; failed: number };
  /**
   * Whether people's 1:1 chats can start work in other workspaces of the
   * organization (see `TeamsReach`). Absent from servers that predate it.
   */
  workspaceRouting?: boolean;
};

/**
 * Where people's Teams 1:1 chats can start work: every workspace of the
 * organization (`workspaceIds: null`) or the selected ones, plus members' own
 * Personal workspaces when `personalWorkspaces` is on. The connected
 * workspace is always included. `version` guards concurrent changes.
 */
export type TeamsReach = {
  workspaceIds: string[] | null;
  personalWorkspaces: boolean;
  version: number;
};

export type TeamsMicrosoftSignInStart = { authorizationUrl: string | null };
/** The Microsoft sign-in that proves the Teams user an account link names. */
export type TeamsLinkSignInStart = { authorizationUrl: string };
/** The `code` and `state` Microsoft returned to the setup page. */
export type TeamsMicrosoftSignInResult = { code: string; state: string };
/**
 * `replaceOwnLink` removes the signed-in person's own link to another Teams
 * account in this workspace, only once setup is otherwise verified.
 */
export type TeamsInstallOptions = { replaceOwnLink?: boolean };

/** Managed-browser setup and linking; these methods never infer an actor or tenant. */
export function teamsApi(client: Pick<OpenGeniClient, "requestJson">, workspaceId: string) {
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/teams`;
  return {
    getBot: (signal?: AbortSignal) =>
      client.requestJson<TeamsBotStatus>(
        "GET",
        `${base}/bot`,
        undefined,
        {},
        signal ? { signal } : {},
      ),
    /**
     * Starts the Microsoft sign-in that proves a tenant administrator for
     * self-serve setup. `authorizationUrl` is null when the operator has
     * already approved this Teams identity, so `installBot` needs no sign-in.
     */
    startMicrosoftSignIn: (setupToken: string) =>
      client.requestJson<TeamsMicrosoftSignInStart>("POST", `${base}/bot/microsoft-sign-in`, {
        setupToken,
      }),
    installBot: (
      setupToken: string,
      microsoft?: TeamsMicrosoftSignInResult,
      options: TeamsInstallOptions = {},
    ) =>
      client.requestJson<TeamsBotStatus>("PUT", `${base}/bot`, {
        setupToken,
        ...(microsoft ? { microsoft } : {}),
        ...(options.replaceOwnLink ? { replaceOwnLink: true } : {}),
      }),
    disconnectBot: () => client.requestJson<{ ok: true }>("DELETE", `${base}/bot`),
    /**
     * Starts the Microsoft sign-in that proves the person opening an account
     * link is the Teams user it names. Microsoft returns to the setup page.
     */
    startLinkSignIn: (token: string) =>
      client.requestJson<TeamsLinkSignInStart>("POST", `${base}/link/microsoft-sign-in`, {
        token,
      }),
    /** Links the account once `microsoft` proves the Teams user the link names. */
    linkAccount: (token: string, microsoft?: TeamsMicrosoftSignInResult) =>
      client.requestJson<{ ok: true }>("POST", `${base}/link`, {
        token,
        ...(microsoft ? { microsoft } : {}),
      }),
    unlinkAccount: () => client.requestJson<{ ok: true }>("DELETE", `${base}/link`),
    /** Where people's Teams chats can start work. */
    getReach: (signal?: AbortSignal) =>
      client.requestJson<TeamsReach>(
        "GET",
        `${base}/reach`,
        undefined,
        {},
        signal ? { signal } : {},
      ),
    /** Organization owners and admins who manage this workspace's integrations change it. */
    setReach: (reach: Omit<TeamsReach, "version">, expectedVersion?: number) =>
      client.requestJson<TeamsReach>("PUT", `${base}/reach`, {
        workspaceIds: reach.workspaceIds,
        personalWorkspaces: reach.personalWorkspaces,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      }),
  };
}
