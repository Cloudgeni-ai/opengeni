import type { OpenGeniClient } from "./client";

export type TeamsBotStatus = {
  enabled: boolean;
  configured: boolean;
  setupAvailable: boolean;
  installation: { tenantId: string; workspaceId: string; active: boolean } | null;
  linked: boolean;
  delivery?: { pending: number; unknown: number; failed: number };
};

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
    installBot: (setupToken: string) =>
      client.requestJson<TeamsBotStatus>("PUT", `${base}/bot`, { setupToken }),
    disconnectBot: () => client.requestJson<{ ok: true }>("DELETE", `${base}/bot`),
    linkAccount: (token: string) =>
      client.requestJson<{ ok: true }>("POST", `${base}/link`, { token }),
    unlinkAccount: () => client.requestJson<{ ok: true }>("DELETE", `${base}/link`),
  };
}
