import type { Settings } from "@opengeni/config";
import {
  McpConnectionResourceScope,
  type ConnectionCredentialsPort,
  type McpCredentialsRequest,
  type McpCredentialResolution,
  type McpGatewayCredentialsRequest,
  type McpGatewayCredentialResolution,
} from "@opengeni/contracts";
import { pinnedFetch, readResponseJsonBounded, validateHttpUrl } from "@opengeni/network";
import { z } from "zod";

const configuration = z
  .array(
    z
      .object({
        accountId: z.string().uuid(),
        url: z.string().max(2048),
        bearerToken: z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[^\r\n]+$/),
        timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
      })
      .strict(),
  )
  .max(128);

const scope = {
  accountId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  providerDomain: z.string(),
  provider: z.string().optional(),
  scopes: z.array(z.string()).max(256).optional(),
  resource: z.string().optional(),
  selectedResources: z.array(McpConnectionResourceScope).max(256).optional(),
};
const resolution = z.discriminatedUnion("status", [
  z
    .object({
      ...scope,
      status: z.literal("ok"),
      connectionId: z.string().min(1),
      headers: z.record(z.string(), z.string()),
      placements: z
        .array(
          z
            .object({
              carrier: z.enum(["header", "query", "cookie"]),
              name: z.string(),
              value: z.string(),
              prefix: z.string().optional(),
            })
            .strict(),
        )
        .max(64)
        .optional(),
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      ...scope,
      status: z.literal("auth_needed"),
      connectionId: z.string().optional(),
      reason: z.enum([
        "missing_connection",
        "expired",
        "insufficient_scope",
        "refresh_failed",
        "personal_authority_unavailable",
        "unsupported_auth",
        "resource_scope_unavailable",
      ]),
      authorizationUrl: z.string().optional(),
    })
    .strict(),
]);
const gatewayResolution = z.discriminatedUnion("status", [
  resolution.options[0].omit({ sessionId: true }).extend({ requestId: z.string().uuid() }),
  resolution.options[1].omit({ sessionId: true }).extend({ requestId: z.string().uuid() }),
]);
const responseEnvelope = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    destinationUrl: z.string(),
    resolution: z.union([resolution, gatewayResolution]),
  })
  .strict();

type RemoteResolution = McpCredentialResolution | McpGatewayCredentialResolution;
function normalizeResolution(
  value: z.infer<typeof resolution> | z.infer<typeof gatewayResolution>,
): RemoteResolution {
  const common = {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    ...("sessionId" in value ? { sessionId: value.sessionId } : { requestId: value.requestId }),
    providerDomain: value.providerDomain,
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.scopes !== undefined ? { scopes: value.scopes } : {}),
    ...(value.resource !== undefined ? { resource: value.resource } : {}),
    ...(value.selectedResources !== undefined
      ? { selectedResources: value.selectedResources }
      : {}),
  };
  if (value.status === "auth_needed")
    return {
      ...common,
      status: "auth_needed",
      reason: value.reason,
      ...(value.connectionId !== undefined ? { connectionId: value.connectionId } : {}),
      ...(value.authorizationUrl !== undefined ? { authorizationUrl: value.authorizationUrl } : {}),
    };
  return {
    ...common,
    status: "ok",
    connectionId: value.connectionId,
    headers: value.headers,
    expiresAt: value.expiresAt,
    ...(value.placements !== undefined
      ? {
          placements: value.placements.map((placement) => ({
            carrier: placement.carrier,
            name: placement.name,
            value: placement.value,
            ...(placement.prefix !== undefined ? { prefix: placement.prefix } : {}),
          })),
        }
      : {}),
  };
}

/** Optional standalone transport for the existing request-time host port.
 * No successful credential is cached or persisted. The host must authorize
 * every immutable request context, including revocation and binding generation.
 */
export function createRemoteMcpCredentialsPort(
  settings: Pick<
    Settings,
    "hostMcpCredentialResolversJson" | "environment" | "integrationsAllowPrivateNetworkTargets"
  >,
  transport: typeof pinnedFetch = pinnedFetch,
): ConnectionCredentialsPort {
  if (!settings.hostMcpCredentialResolversJson) return {};
  let entries: z.infer<typeof configuration>;
  try {
    entries = configuration.parse(JSON.parse(settings.hostMcpCredentialResolversJson));
    for (const entry of entries) validateHttpUrl(entry.url);
    if (new Set(entries.map((entry) => entry.accountId)).size !== entries.length) throw new Error();
  } catch {
    // Configuration includes credentials: never return parser input or causes.
    throw new Error("Invalid host MCP credential resolver configuration");
  }
  const byAccount = new Map(entries.map((entry) => [entry.accountId, entry]));
  const active = new Map<string, Promise<RemoteResolution>>();
  let physicalRequests = 0;
  const resolveRemote = async (
    input: McpCredentialsRequest | McpGatewayCredentialsRequest,
  ): Promise<RemoteResolution> => {
    const serialized = JSON.stringify(input);
    const request: McpCredentialsRequest | McpGatewayCredentialsRequest = JSON.parse(serialized);
    const unavailable = (reason: "unsupported_auth" | "refresh_failed"): RemoteResolution => ({
      status: "auth_needed",
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      ...("sessionId" in request
        ? { sessionId: request.sessionId }
        : { requestId: request.requestId }),
      providerDomain: request.connectionRef.providerDomain,
      ...(request.connectionRef.provider !== undefined
        ? { provider: request.connectionRef.provider }
        : {}),
      ...(request.connectionRef.connectionId !== undefined
        ? { connectionId: request.connectionRef.connectionId }
        : {}),
      ...(request.connectionRef.scopes !== undefined
        ? { scopes: request.connectionRef.scopes }
        : {}),
      ...(request.connectionRef.resource !== undefined
        ? { resource: request.connectionRef.resource }
        : {}),
      ...(request.connectionRef.selectedResources !== undefined
        ? { selectedResources: request.connectionRef.selectedResources }
        : {}),
      reason,
    });
    const config = byAccount.get(request.accountId);
    if (!config || request.connectionRef.authoritySource !== "host")
      return unavailable("unsupported_auth");
    // Snapshot before any asynchronous operation; never retain mutable caller
    // objects as the authority for a delayed response.
    if (new TextEncoder().encode(serialized).byteLength > 65_536)
      return unavailable("refresh_failed");
    const pending = active.get(serialized);
    if (pending) return structuredClone(await pending);
    if (physicalRequests >= 128) return unavailable("refresh_failed");
    const run = async (): Promise<RemoteResolution> => {
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Host resolver deadline"));
        }, config.timeoutMs);
      });
      try {
        physicalRequests++;
        return await Promise.race([
          deadline,
          (async () => {
            const response = await transport(
              config.url,
              {
                method: "POST",
                redirect: "manual",
                signal: controller.signal,
                headers: {
                  Authorization: `Bearer ${config.bearerToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ version: 1, requestId, request }),
              },
              settings,
              { requireHttpsOutsideLocalTest: true, label: "Host MCP credential resolver" },
            );
            if (!response.ok) {
              await response.body?.cancel();
              return unavailable("refresh_failed");
            }
            const parsed = responseEnvelope.parse(
              await readResponseJsonBounded(response, 65_536, "Host MCP credential resolver", {
                signal: controller.signal,
              }),
            );
            if (
              parsed.requestId !== requestId ||
              parsed.destinationUrl !== request.destinationUrl ||
              parsed.resolution.accountId !== request.accountId ||
              parsed.resolution.workspaceId !== request.workspaceId ||
              ("sessionId" in request
                ? !("sessionId" in parsed.resolution) ||
                  parsed.resolution.sessionId !== request.sessionId
                : !("requestId" in parsed.resolution) ||
                  parsed.resolution.requestId !== request.requestId)
            )
              return unavailable("refresh_failed");
            if (
              parsed.resolution.status === "ok" &&
              (Date.parse(parsed.resolution.expiresAt) <= Date.now() + 5_000 ||
                Date.parse(parsed.resolution.expiresAt) > Date.now() + 900_000)
            ) {
              return unavailable("refresh_failed");
            }
            // Existing buildHostConnectionTokenResolver validates the precise
            // connection, provider, scopes, resources and credential placements.
            return normalizeResolution(parsed.resolution);
          })().finally(() => {
            physicalRequests--;
          }),
        ]);
      } catch {
        return unavailable("refresh_failed");
      } finally {
        clearTimeout(timer);
      }
    };
    const task = run();
    active.set(serialized, task);
    try {
      return structuredClone(await task);
    } finally {
      if (active.get(serialized) === task) active.delete(serialized);
    }
  };
  return {
    mcpAuthoritySource: "host",
    async mcpCredentials(input) {
      const result = await resolveRemote(input);
      if (!("sessionId" in result)) throw new Error("Invalid host turn credential scope");
      return result;
    },
    async mcpGatewayCredentials(input) {
      const result = await resolveRemote(input);
      if (!("requestId" in result)) throw new Error("Invalid host gateway credential scope");
      return result;
    },
  };
}
