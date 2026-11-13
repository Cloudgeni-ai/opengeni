import type { McpServerConfig, Settings } from "@opengeni/config";
import {
  NANGO_REPLACEABLE_NATIVE_SOCIAL_PROVIDERS,
  isNangoProviderDomain,
  nangoIntegrationKeyFromProviderDomain,
  nangoProviderDomain,
  nangoToolsMcpUrl,
  nativeNangoIntegrationByKey,
  nativeNangoIntegrationForMcpUrl,
  nativeNangoIntegrationForProviderDomain,
  type ConnectionMetadata,
  type EffectiveNangoIntegration,
} from "@opengeni/contracts";
import { readEffectiveNangoIntegrations, type Database } from "@opengeni/db";

/**
 * The integration backend switch applied to runtime settings and connection
 * reads (docs/nango.md). One catalog entry per service: a Nango-backed native
 * Google connector keeps its catalog identity and only resolves Nango
 * connections; a config-only integration (LinkedIn, X, ...) is a deployment
 * MCP server served by the generic Nango tools bridge.
 */
export type NangoBackends = ReadonlyMap<string, EffectiveNangoIntegration>;

const EMPTY: NangoBackends = new Map();

export async function nangoBackendsFor(
  db: Database,
  settings: Pick<Settings, "nangoSecretKey">,
): Promise<NangoBackends> {
  if (!settings.nangoSecretKey) return EMPTY;
  try {
    return await readEffectiveNangoIntegrations(db, settings);
  } catch {
    // The switch is read best effort: unreadable means every integration native.
    return EMPTY;
  }
}

/** Runtime server id of a config-only Nango integration. */
export function nangoMcpServerId(integrationKey: string): string {
  return `nango-${integrationKey}`;
}

/** The deployment MCP server a config-only Nango integration contributes. */
export function nangoMcpServerConfig(integration: EffectiveNangoIntegration): McpServerConfig {
  const definition = integration.definition;
  return {
    id: nangoMcpServerId(integration.integrationKey),
    name: definition.displayName ?? integration.integrationKey,
    url: nangoToolsMcpUrl(integration.integrationKey),
    cacheToolsList: false,
    ...(definition.tools?.allow?.length ? { allowedTools: [...definition.tools.allow] } : {}),
    connectionRef: {
      providerDomain: integration.providerDomain,
      // Nango connections are always the connecting person's own account.
      subjectScope: "subject",
      kind: "oauth2",
    },
  };
}

/**
 * Point every native Google connector at its Nango connection identity while
 * it is Nango-backed, and add the config-only integrations. Native and Nango
 * connections have distinct provider domains, so neither satisfies the other.
 */
export function applyNangoBackendsToSettings<T extends Pick<Settings, "mcpServers">>(
  settings: T,
  backends: NangoBackends,
): T {
  if (backends.size === 0) return settings;
  const servers = settings.mcpServers.map((server) => {
    const native = nativeNangoIntegrationForMcpUrl(server.url);
    const ref = server.connectionRef;
    if (
      !native ||
      !backends.has(native.integrationKey) ||
      !ref ||
      ref.authoritySource === "host" ||
      ref.providerDomain.trim().toLowerCase() !== native.nativeProviderDomain
    )
      return server;
    // Requested incremental scopes do not apply: a managed app's scopes are
    // fixed, and each bridge gates its tools on the recorded grants.
    const { connectionId: _nativeConnection, scopes: _requestedScopes, ...rest } = ref;
    return {
      ...server,
      connectionRef: {
        ...rest,
        providerDomain: nangoProviderDomain(native.integrationKey),
        kind: "oauth2" as const,
      },
    };
  });
  const taken = new Set(servers.map((server) => server.id));
  for (const integration of backends.values()) {
    if (integration.native) continue;
    const server = nangoMcpServerConfig(integration);
    if (taken.has(server.id)) continue;
    taken.add(server.id);
    servers.push(server);
  }
  return { ...settings, mcpServers: servers };
}

/** Native social providers whose card and tools are hidden while Nango serves them. */
export function nangoReplacedSocialProviders(backends: NangoBackends): Set<string> {
  const hidden = new Set<string>();
  for (const [key, provider] of Object.entries(NANGO_REPLACEABLE_NATIVE_SOCIAL_PROVIDERS))
    if (backends.has(key)) hidden.add(provider);
  return hidden;
}

/** Metadata a projected connection carries; never stored. */
export const INTEGRATION_BACKEND_PROJECTION_KEY = "integrationBackendProjection";

/**
 * How connections read while a backend is switched. Nothing stored changes:
 * - native connections of a Nango-backed integration read as needing
 *   reconnection (reconnecting leads to the Nango Connect card), marked
 *   superseded once their owner has an active Nango connection for it;
 * - Nango connections of an integration that is native again read as inactive.
 * Flipping back restores the stored status exactly.
 */
export function projectConnectionsForBackends<T extends ConnectionMetadata>(
  connections: readonly T[],
  backends: NangoBackends,
): T[] {
  const nangoOwners = new Set<string>();
  for (const connection of connections) {
    const key = nangoIntegrationKeyFromProviderDomain(connection.providerDomain);
    if (key && backends.has(key) && connection.status === "active")
      nangoOwners.add(`${key}\u0000${connection.subjectId ?? ""}`);
  }
  return connections.map((connection) => {
    if (connection.status !== "active" && connection.status !== "needs_reauth") return connection;
    const native = isNangoProviderDomain(connection.providerDomain)
      ? null
      : nativeNangoIntegrationForProviderDomain(connection.providerDomain);
    if (native && backends.has(native.integrationKey)) {
      const superseded = nangoOwners.has(
        `${native.integrationKey}\u0000${connection.subjectId ?? ""}`,
      );
      return {
        ...connection,
        // Either way the account cannot be used until it is connected
        // through Nango; a superseded one is already replaced, so it is not
        // listed among accounts needing a reconnect.
        status: "needs_reauth",
        metadata: {
          ...connection.metadata,
          [INTEGRATION_BACKEND_PROJECTION_KEY]: superseded ? "superseded" : "reconnect",
        },
      };
    }
    if (isNangoProviderDomain(connection.providerDomain)) {
      const key = nangoIntegrationKeyFromProviderDomain(connection.providerDomain);
      if (key && !backends.has(key))
        return {
          ...connection,
          status: "error",
          metadata: { ...connection.metadata, [INTEGRATION_BACKEND_PROJECTION_KEY]: "inactive" },
        };
    }
    return connection;
  });
}

/**
 * The provider domain a capability installation stores: always the native
 * catalog identity for a native Google connector, whatever backend connected
 * it, so a flip never rewrites installations.
 */
export function catalogProviderDomain(providerDomain: string): string {
  const key = nangoIntegrationKeyFromProviderDomain(providerDomain);
  const native = key ? nativeNangoIntegrationByKey(key) : null;
  return native ? native.nativeProviderDomain : providerDomain;
}
