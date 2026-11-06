import type { OpenGeniClient } from "./client";

export type TeamsBotStatus = {
  enabled: boolean;
  configured: boolean;
  setupAvailable: boolean;
  installation: { tenantId: string; workspaceId: string; active: boolean } | null;
  linked: boolean;
  delivery?: { pending: number; unknown: number; failed: number };
};

export type TeamsMicrosoftSignInStart = { authorizationUrl: string | null };
/** The `code` and `state` Microsoft returned to the setup page. */
export type TeamsMicrosoftSignInResult = { code: string; state: string };

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
    installBot: (setupToken: string, microsoft?: TeamsMicrosoftSignInResult) =>
      client.requestJson<TeamsBotStatus>(
        "PUT",
        `${base}/bot`,
        microsoft ? { setupToken, microsoft } : { setupToken },
      ),
    disconnectBot: () => client.requestJson<{ ok: true }>("DELETE", `${base}/bot`),
    linkAccount: (token: string) =>
      client.requestJson<{ ok: true }>("POST", `${base}/link`, { token }),
    unlinkAccount: () => client.requestJson<{ ok: true }>("DELETE", `${base}/link`),
  };
}
