import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  signDelegatedAccessToken,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import {
  firstPartyMcpInternalWorkspaceUrl,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import { OpenGeniClient } from "@opengeni/sdk";
import { guardedMcpFetch } from "./mcp-network";

/** Internal calls carry the same exact attempt and tool selection as MCP. */
export function createFirstPartyAttemptClient(input: {
  settings: Settings;
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
  };
  selectedTools: readonly FirstPartyMcpToolName[];
  permissions?: readonly Permission[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) {
  const secret = resolveFirstPartyDelegationSecret(input.settings);
  if (!secret) throw new Error("First-party task access is unavailable");
  const url = new URL(firstPartyMcpInternalWorkspaceUrl(input.settings, input.scope.workspaceId));
  const suffix = `/v1/workspaces/${input.scope.workspaceId}/mcp`;
  if (!url.pathname.endsWith(suffix)) throw new Error("First-party API URL is invalid");
  url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  url.search = "";
  url.hash = "";
  const guarded = guardedMcpFetch(
    { ...input.settings, integrationsAllowPrivateNetworkTargets: true },
    input.fetch ?? globalThis.fetch.bind(globalThis),
    {
      requireHttpsOutsideLocalTest: false,
      ...(process.versions.bun ? { pinResolvedDestination: false } : {}),
    },
  );
  return new OpenGeniClient({
    baseUrl: url.toString(),
    fetch: async (request, init) => {
      const bearer = await signDelegatedAccessToken(secret, {
        ...input.scope,
        subjectId: "worker:knowledge-preparation",
        principalKind: "agent_attempt",
        permissions: [...(input.permissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS)],
        firstPartyMcpTools: [...input.selectedTools],
        exp: Math.floor(Date.now() / 1_000) + 60 * 60,
      });
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      const signals = [input.signal, init?.signal].filter(
        (signal): signal is AbortSignal => !!signal,
      );
      return guarded(request, {
        ...init,
        headers,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      });
    },
  });
}
